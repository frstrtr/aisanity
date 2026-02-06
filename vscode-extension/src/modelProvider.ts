/**
 * aisanity Language Model Provider — appears in the VS Code model dropdown
 *
 * When the user selects "aisanity" as their model in the chat model picker,
 * EVERY request from ANY participant (Copilot, workspace, etc.) gets proxied:
 *
 *   1. Injects project memory into the system context
 *   2. Forwards to the configured Ollama model for generation
 *   3. Validates the full response against .ai-memory.md
 *   4. If violations → auto-corrects and re-validates (configurable)
 *   5. Streams the validated (or corrected) response back
 *
 * Configuration:
 *   - aisanity.enableValidation — turn validation on/off
 *   - aisanity.enableAutoCorrection — turn disagreement flow on/off
 *   - aisanity.maxCorrectionRetries — how many times to retry corrections
 *   - aisanity.showValidationBadges — show ✅/⚠️ badges
 *   - aisanity.ollamaUrl / ollamaModel — Ollama server config
 *
 * The model also picks up per-group configuration from the VS Code
 * Manage Models UI (ollamaUrl, ollamaModel fields).
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

    // Inject memory as opening system-level context
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

// ── Resolve effective Ollama config ─────────────────────────────────────────

interface OllamaConfig {
    url: string;
    model: string;
}

/**
 * Resolve the Ollama URL and model from (in priority order):
 * 1. Per-group configuration from Manage Models UI
 * 2. Extension settings (aisanity.ollamaUrl / aisanity.ollamaModel)
 * 3. Defaults
 */
function resolveOllamaConfig(
    groupConfig?: { readonly [key: string]: any },
): OllamaConfig {
    const extConfig = getConfig();
    return {
        url:
            groupConfig?.ollamaUrl ||
            extConfig.get<string>("ollamaUrl", DEFAULTS.ollamaUrl),
        model:
            groupConfig?.ollamaModel ||
            extConfig.get<string>("ollamaModel", DEFAULTS.ollamaModel),
    };
}

// ── Model Provider ──────────────────────────────────────────────────────────

export class AisanityModelProvider
    implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>
{
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

    /** Stores the per-group configuration from the Manage Models UI */
    private _groupConfig: { readonly [key: string]: any } | undefined;

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // Store configuration from Manage Models UI for later use
        this._groupConfig = (options as any).configuration;

        const { model: ollamaModel } = resolveOllamaConfig(this._groupConfig);

        return [
            {
                id: "aisanity-guardian",
                name: `aisanity (${ollamaModel})`,
                family: "aisanity",
                version: "0.5.0",
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
        const { url: ollamaUrl, model: ollamaModel } = resolveOllamaConfig(this._groupConfig);

        const enableValidation = config.get<boolean>("enableValidation", true);
        const enableAutoCorrection = config.get<boolean>("enableAutoCorrection", true);
        const maxRetries = config.get<number>("maxCorrectionRetries", 1);
        const showBadges = config.get<boolean>("showValidationBadges", true);

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

        // ── Step 2: If validation disabled or no memory, stream directly
        if (!enableValidation || !memoryPath || !memoryText) {
            progress.report(new vscode.LanguageModelTextPart(response));
            if (showBadges) {
                if (!memoryPath || !memoryText) {
                    progress.report(new vscode.LanguageModelTextPart(
                        "\n\n---\n⚠️ *No .ai-memory.md — response not validated*\n",
                    ));
                } else {
                    progress.report(new vscode.LanguageModelTextPart(
                        "\n\n---\n🔇 *aisanity validation disabled*\n",
                    ));
                }
            }
            return;
        }

        // ── Step 3: Validate against project memory
        const guardian = new MemoryGuardian({
            memoryFile: memoryPath,
            ollamaUrl,
            ollamaModel,
            githubModel: config.get<string>("githubModel"),
            githubToken: process.env.GITHUB_TOKEN,
        });

        let verdict: Verdict;
        try {
            verdict = await guardian.validate(response);
        } catch {
            // Validation infra failed — return original with warning
            progress.report(new vscode.LanguageModelTextPart(response));
            if (showBadges) {
                progress.report(new vscode.LanguageModelTextPart(
                    "\n\n---\n⚠️ *aisanity validation unavailable — response not checked*\n",
                ));
            }
            return;
        }

        if (token.isCancellationRequested) return;

        // ── Step 4a: Clean — stream original
        if (verdict.is_valid) {
            progress.report(new vscode.LanguageModelTextPart(response));
            if (showBadges) {
                progress.report(new vscode.LanguageModelTextPart(
                    "\n\n---\n✅ *Validated by aisanity — complies with project memory*\n",
                ));
            }
            return;
        }

        // ── Step 4b: Violations — report them
        if (showBadges) {
            progress.report(new vscode.LanguageModelTextPart(
                "---\n⚠️ **aisanity intercepted violations**" +
                (enableAutoCorrection && maxRetries > 0 ? " — auto-correcting…" : "") +
                "\n\n",
            ));
            for (const v of verdict.violations) {
                progress.report(new vscode.LanguageModelTextPart(
                    `- **${v.rule}**: found \`${v.found}\` → expected \`${v.expected}\` — ${v.explanation}\n`,
                ));
            }
            progress.report(new vscode.LanguageModelTextPart(
                `\n*\\[validator: ${verdict.backend} / ${verdict.model}\\]*\n\n---\n\n`,
            ));
        }

        // If auto-correction is disabled, just show the original response
        if (!enableAutoCorrection || maxRetries === 0) {
            progress.report(new vscode.LanguageModelTextPart(response));
            if (showBadges) {
                progress.report(new vscode.LanguageModelTextPart(
                    "\n\n---\n⚠️ *Auto-correction disabled — review violations above manually*\n",
                ));
            }
            return;
        }

        // ── Step 5: Auto-correct loop (up to maxRetries)
        let currentResponse = response;
        let currentVerdict = verdict;
        let correctionHistory = [...ollamaMessages];

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (token.isCancellationRequested) return;

            const violationsSummary = currentVerdict.violations
                .map(
                    (v, i) =>
                        `${i + 1}. [${v.rule}] Used \`${v.found}\` but should use \`${v.expected}\` — ${v.explanation}`,
                )
                .join("\n");

            const correctionMessages: OllamaMessage[] = [
                ...correctionHistory,
                { role: "assistant", content: currentResponse },
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
                progress.report(new vscode.LanguageModelTextPart(
                    `❌ Correction attempt ${attempt + 1} failed: ${err.message}\n\n**Original response:**\n\n`,
                ));
                progress.report(new vscode.LanguageModelTextPart(currentResponse));
                return;
            }

            if (token.isCancellationRequested) return;

            // Re-validate the correction
            try {
                const recheck = await guardian.validate(corrected);
                if (recheck.is_valid) {
                    // Success!
                    progress.report(new vscode.LanguageModelTextPart(corrected));
                    if (showBadges) {
                        progress.report(new vscode.LanguageModelTextPart(
                            `\n\n---\n✅ *Corrected and validated by aisanity (attempt ${attempt + 1}) — now complies with project memory*\n`,
                        ));
                    }
                    return;
                }

                // Still has violations — try again or give up
                currentResponse = corrected;
                currentVerdict = recheck;
                correctionHistory = correctionMessages;
            } catch {
                // Re-validation failed — return the correction anyway
                progress.report(new vscode.LanguageModelTextPart(corrected));
                if (showBadges) {
                    progress.report(new vscode.LanguageModelTextPart(
                        "\n\n---\n⚡ *Corrected by aisanity (re-validation skipped)*\n",
                    ));
                }
                return;
            }
        }

        // Exhausted retries — return last corrected version with remaining issues
        progress.report(new vscode.LanguageModelTextPart(currentResponse));
        if (showBadges) {
            const remaining = currentVerdict.violations
                .map((v) => `\`${v.rule}\`: ${v.explanation}`)
                .join(", ");
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n---\n⚠️ *aisanity: ${currentVerdict.violations.length} issue(s) may remain after ${maxRetries} correction(s): ${remaining}. Review manually.*\n`,
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
