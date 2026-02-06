/**
 * aisanity Language Model Provider — appears in the VS Code model dropdown
 *
 * When the user selects "aisanity" as their model in the chat model picker,
 * EVERY request from ANY participant (Copilot, workspace, etc.) gets proxied:
 *
 *   1. Injects project memory into the system context
 *   2. Forwards to the configured Ollama model for generation
 *   3. Validates the full response against .ai-memory.md
 *   4. If violations → auto-corrects and re-validates
 *   5. Streams the validated (or corrected) response back
 *
 * This is the simplest UX: just pick the model and forget about it.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { MemoryGuardian, type Verdict, DEFAULTS } from "./guardian";

// ── Helpers ─────────────────────────────────────────────────────────────────

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("aisanity");
}

function findMemoryFile(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return undefined;
    const name = getConfig().get<string>("memoryFile", ".ai-memory.md");
    for (const f of folders) {
        const p = path.join(f.uri.fsPath, name);
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

// ── Ollama streaming helper ─────────────────────────────────────────────────

interface OllamaMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * Call Ollama /api/chat and collect the full response (non-streaming).
 * We need the full text to validate before streaming to VS Code.
 */
function ollamaChat(
    baseUrl: string,
    model: string,
    messages: OllamaMessage[],
    token: vscode.CancellationToken,
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (token.isCancellationRequested) {
            reject(new Error("Cancelled"));
            return;
        }

        const parsed = new URL(`${baseUrl}/api/chat`);
        const isHttps = parsed.protocol === "https:";
        const mod = isHttps ? https : http;

        const payload = JSON.stringify({
            model,
            messages,
            stream: false,
            options: { temperature: 0.3 },
        });

        const reqOpts: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
            timeout: DEFAULTS.httpTimeout,
        };

        const req = mod.request(reqOpts, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf-8");
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Ollama HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
                    return;
                }
                try {
                    const data = JSON.parse(body);
                    resolve(data.message?.content ?? "");
                } catch (e: any) {
                    reject(new Error(`Ollama response parse error: ${e.message}`));
                }
            });
        });

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Ollama request timeout"));
        });

        const cancelListener = token.onCancellationRequested(() => {
            req.destroy();
            reject(new Error("Cancelled"));
        });

        req.on("close", () => cancelListener.dispose());
        req.write(payload);
        req.end();
    });
}

// ── Convert VS Code messages to Ollama format ───────────────────────────────

function convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    memoryText: string | undefined,
): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    // Inject memory as opening system-level context in the first user message
    if (memoryText) {
        result.push({
            role: "system",
            content:
                "You are a helpful coding assistant. The following project memory " +
                "defines rules you MUST follow. Read it carefully and comply with " +
                "every requirement.\n\n---\n" +
                memoryText +
                "\n---\n\nFollow the above rules strictly in all responses.",
        });
    }

    for (const msg of messages) {
        const role: OllamaMessage["role"] =
            msg.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";

        // Extract text content from message parts
        let text = "";
        for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            }
        }
        if (text) {
            result.push({ role, content: text });
        }
    }

    return result;
}

// ── Model Provider ──────────────────────────────────────────────────────────

export class AisanityModelProvider
    implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>
{
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = getConfig();
        const ollamaModel = config.get<string>("ollamaModel", DEFAULTS.ollamaModel);

        return [
            {
                id: "aisanity-guardian",
                name: `aisanity (${ollamaModel} + validation)`,
                family: "aisanity",
                version: "0.3.0",
                tooltip: "Proxies through Ollama with automatic project memory validation",
                detail: `Ollama ${ollamaModel} → validate against .ai-memory.md → auto-correct`,
                maxInputTokens: 32_000,
                maxOutputTokens: 8_000,
                capabilities: {
                    toolCalling: false,
                    imageInput: false,
                },
            },
        ];
    }

    async provideLanguageModelChatResponse(
        _model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        _options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const config = getConfig();
        const ollamaUrl = config.get<string>("ollamaUrl", DEFAULTS.ollamaUrl);
        const ollamaModel = config.get<string>("ollamaModel", DEFAULTS.ollamaModel);

        const memoryPath = findMemoryFile();
        const memoryText = memoryPath ? fs.readFileSync(memoryPath, "utf-8") : undefined;

        // ── Step 1: Convert and forward to Ollama
        const ollamaMessages = convertMessages(messages, memoryText);
        let response: string;

        try {
            response = await ollamaChat(ollamaUrl, ollamaModel, ollamaMessages, token);
        } catch (err: any) {
            progress.report(new vscode.LanguageModelTextPart(
                `❌ Ollama request failed: ${err.message ?? err}`,
            ));
            return;
        }

        if (token.isCancellationRequested) return;

        // ── Step 2: If no memory, stream directly
        if (!memoryPath || !memoryText) {
            progress.report(new vscode.LanguageModelTextPart(response));
            progress.report(new vscode.LanguageModelTextPart(
                "\n\n---\n⚠️ *No .ai-memory.md — response not validated*\n",
            ));
            return;
        }

        // ── Step 3: Validate against project memory
        const guardian = new MemoryGuardian({
            memoryFile: memoryPath,
            ollamaUrl: config.get<string>("ollamaUrl"),
            ollamaModel: config.get<string>("ollamaModel"),
            githubModel: config.get<string>("githubModel"),
            githubToken: process.env.GITHUB_TOKEN,
        });

        let verdict: Verdict;
        try {
            verdict = await guardian.validate(response);
        } catch {
            // Validation infra failed — return original with warning
            progress.report(new vscode.LanguageModelTextPart(response));
            progress.report(new vscode.LanguageModelTextPart(
                "\n\n---\n⚠️ *aisanity validation unavailable — response not checked*\n",
            ));
            return;
        }

        if (token.isCancellationRequested) return;

        // ── Step 4a: Clean — stream original
        if (verdict.is_valid) {
            progress.report(new vscode.LanguageModelTextPart(response));
            progress.report(new vscode.LanguageModelTextPart(
                "\n\n---\n✅ *Validated by aisanity — complies with project memory*\n",
            ));
            return;
        }

        // ── Step 4b: Violations — auto-correct via Ollama
        const violationsSummary = verdict.violations
            .map(
                (v, i) =>
                    `${i + 1}. [${v.rule}] Used \`${v.found}\` but should use \`${v.expected}\` — ${v.explanation}`,
            )
            .join("\n");

        // Show what was caught
        progress.report(new vscode.LanguageModelTextPart(
            "---\n⚠️ **aisanity intercepted violations** — auto-correcting…\n\n",
        ));
        for (const v of verdict.violations) {
            progress.report(new vscode.LanguageModelTextPart(
                `- **${v.rule}**: found \`${v.found}\` → expected \`${v.expected}\` — ${v.explanation}\n`,
            ));
        }
        progress.report(new vscode.LanguageModelTextPart(
            `\n*\\[validator: ${verdict.backend} / ${verdict.model}\\]*\n\n---\n\n`,
        ));

        // Ask Ollama to correct
        const correctionMessages: OllamaMessage[] = [
            ...ollamaMessages,
            { role: "assistant", content: response },
            {
                role: "user",
                content:
                    `Your previous response has these violations of the project rules:\n\n` +
                    `${violationsSummary}\n\n` +
                    `Provide a CORRECTED response that fixes ALL violations. ` +
                    `Follow every rule in the project memory strictly. ` +
                    `Do not apologize or explain what changed — just give the corrected response.`,
            },
        ];

        let corrected: string;
        try {
            corrected = await ollamaChat(ollamaUrl, ollamaModel, correctionMessages, token);
        } catch (err: any) {
            // Correction failed — show original
            progress.report(new vscode.LanguageModelTextPart(
                `❌ Correction request failed: ${err.message}\n\n**Original response:**\n\n`,
            ));
            progress.report(new vscode.LanguageModelTextPart(response));
            return;
        }

        if (token.isCancellationRequested) return;

        // Stream corrected response
        progress.report(new vscode.LanguageModelTextPart(corrected));

        // ── Step 5: Re-validate the correction
        try {
            const recheck = await guardian.validate(corrected);
            if (recheck.is_valid) {
                progress.report(new vscode.LanguageModelTextPart(
                    "\n\n---\n✅ *Corrected and validated by aisanity — now complies with project memory*\n",
                ));
            } else {
                const remaining = recheck.violations
                    .map((v) => `\`${v.rule}\`: ${v.explanation}`)
                    .join(", ");
                progress.report(new vscode.LanguageModelTextPart(
                    `\n\n---\n⚠️ *aisanity: ${recheck.violations.length} issue(s) may remain: ${remaining}. Review manually.*\n`,
                ));
            }
        } catch {
            progress.report(new vscode.LanguageModelTextPart(
                "\n\n---\n⚡ *Corrected by aisanity (re-validation skipped)*\n",
            ));
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken,
    ): Promise<number> {
        // Rough estimate: ~4 chars per token (good enough for context window management)
        const str =
            typeof text === "string"
                ? text
                : text.content
                      .map((p: any) => (p instanceof vscode.LanguageModelTextPart ? p.value : ""))
                      .join("");
        return Math.ceil(str.length / 4);
    }

    refresh(): void {
        this._onDidChange.fire();
    }
}
