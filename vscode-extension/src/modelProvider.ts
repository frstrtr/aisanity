/**
 * aisanity Language Model Provider — appears in the VS Code model dropdown
 *
 * When the user selects "aisanity" as their model in the chat model picker,
 * EVERY request from ANY participant gets proxied through validation:
 *
 *   1. Injects project memory into the system context
 *   2. Forwards to the "main model" for generation:
 *      - ollama (default) → direct Ollama HTTP call
 *      - copilot:gpt-4o, copilot:claude-sonnet-4, etc. → VS Code model API
 *   3. Validates the full response against .ai-memory.md (always via Ollama)
 *   4. If violations → auto-corrects and re-validates (configurable)
 *   5. Streams the validated (or corrected) response back
 *
 * Key setting: aisanity.mainModel
 *   - "ollama" (default) → Ollama does both generation + validation
 *   - "copilot:gpt-4o"  → Copilot GPT-4o generates, Ollama validates
 *   - "copilot:claude-sonnet-4" → Claude generates, Ollama validates
 *   - Any VS Code model ID → that model generates, Ollama validates
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

// ── Ollama helper ───────────────────────────────────────────────────────────

interface OllamaMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * Call Ollama /api/chat and collect the full response (non-streaming).
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

function convertToOllamaMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    memoryText: string | undefined,
): OllamaMessage[] {
    const result: OllamaMessage[] = [];

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

// ── Convert VS Code request messages → LanguageModelChatMessage for VS Code model API ──

function convertToVscodeMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    memoryText: string | undefined,
): vscode.LanguageModelChatMessage[] {
    const result: vscode.LanguageModelChatMessage[] = [];

    // Inject memory as the first user message (system preamble)
    if (memoryText) {
        result.push(
            vscode.LanguageModelChatMessage.User(
                "You are a helpful coding assistant. The following project memory " +
                "defines rules you MUST follow. Read it carefully and comply with " +
                "every requirement.\n\n---\n" +
                memoryText +
                "\n---\n\nFollow the above rules strictly in all responses.",
            ),
        );
    }

    for (const msg of messages) {
        let text = "";
        for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            }
        }
        if (!text) continue;

        if (msg.role === vscode.LanguageModelChatMessageRole.User) {
            result.push(vscode.LanguageModelChatMessage.User(text));
        } else {
            result.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
    }

    return result;
}

// ── Resolve effective Ollama config ─────────────────────────────────────────

interface OllamaConfig {
    url: string;
    model: string;
}

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

// ── Parse mainModel selector ────────────────────────────────────────────────

interface MainModelSelector {
    kind: "ollama" | "vscode-model";
    /** For vscode-model: the raw model ID string (e.g. "copilot:gpt-4o") */
    id?: string;
    /** Parsed vendor (e.g. "copilot") */
    vendor?: string;
    /** Parsed family (e.g. "gpt-4o") */
    family?: string;
}

function parseMainModel(setting: string): MainModelSelector {
    if (!setting || setting === "ollama") {
        return { kind: "ollama" };
    }

    // Format: "vendor:family" (e.g. "copilot:gpt-4o") or just a model ID
    const parts = setting.split(":");
    if (parts.length >= 2) {
        return {
            kind: "vscode-model",
            id: setting,
            vendor: parts[0],
            family: parts.slice(1).join(":"),
        };
    }

    // Treat as a raw model ID
    return { kind: "vscode-model", id: setting };
}

/**
 * Resolve a VS Code LanguageModelChat from a MainModelSelector.
 * Returns null if no matching model is found.
 */
async function resolveVscodeModel(
    selector: MainModelSelector,
): Promise<vscode.LanguageModelChat | null> {
    const chatSelector: vscode.LanguageModelChatSelector = {};

    if (selector.vendor) chatSelector.vendor = selector.vendor;
    if (selector.family) chatSelector.family = selector.family;
    if (selector.id && !selector.vendor) chatSelector.id = selector.id;

    const models = await vscode.lm.selectChatModels(chatSelector);

    if (models.length === 0) {
        // Fallback: try matching by ID across all models
        if (selector.id) {
            const all = await vscode.lm.selectChatModels();
            const match = all.find(
                (m) =>
                    m.id === selector.id ||
                    m.id.includes(selector.id!) ||
                    `${m.vendor}:${m.family}` === selector.id,
            );
            return match ?? null;
        }
        return null;
    }

    return models[0];
}

/**
 * Send a request to a VS Code LanguageModelChat and collect the full response.
 */
async function sendToVscodeModel(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
): Promise<string> {
    const response = await model.sendRequest(messages, {}, token);
    let full = "";
    for await (const chunk of response.text) {
        full += chunk;
    }
    return full;
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
        this._groupConfig = (options as any).configuration;

        const config = getConfig();
        const mainModelSetting = config.get<string>("mainModel", "ollama");
        const { model: ollamaModel } = resolveOllamaConfig(this._groupConfig);

        // Build descriptive name based on main model
        let modelName: string;
        let modelDetail: string;
        if (mainModelSetting === "ollama") {
            modelName = `aisanity (${ollamaModel})`;
            modelDetail = `Ollama ${ollamaModel} → validate → auto-correct`;
        } else {
            modelName = `aisanity (${mainModelSetting} + validation)`;
            modelDetail = `${mainModelSetting} generates → Ollama ${ollamaModel} validates → auto-correct`;
        }

        return [
            {
                id: "aisanity-guardian",
                name: modelName,
                family: "aisanity",
                version: "0.5.1",
                tooltip: "Proxies through a main model with automatic project memory validation via Ollama",
                detail: modelDetail,
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

        const mainModelSetting = config.get<string>("mainModel", "ollama");
        const enableValidation = config.get<boolean>("enableValidation", true);
        const enableAutoCorrection = config.get<boolean>("enableAutoCorrection", true);
        const maxRetries = config.get<number>("maxCorrectionRetries", 1);
        const showBadges = config.get<boolean>("showValidationBadges", true);

        const memoryPath = findMemoryFile();
        const memoryText = memoryPath ? fs.readFileSync(memoryPath, "utf-8") : undefined;

        const mainModel = parseMainModel(mainModelSetting);

        // ── Step 1: Generate response via the main model ────────────────

        let response: string;
        let resolvedMainModel: vscode.LanguageModelChat | null = null;

        if (mainModel.kind === "vscode-model") {
            // Use a VS Code model (e.g. Copilot GPT-4o) for generation
            resolvedMainModel = await resolveVscodeModel(mainModel);
            if (!resolvedMainModel) {
                progress.report(new vscode.LanguageModelTextPart(
                    `❌ Main model "${mainModelSetting}" not found.\n\n` +
                    `Available models can be found via the model picker. ` +
                    `Use the format \`vendor:family\` (e.g. \`copilot:gpt-4o\`, \`copilot:claude-sonnet-4\`), ` +
                    `or set to \`ollama\` to use Ollama directly.\n\n` +
                    `Falling back to Ollama (${ollamaModel})…\n\n---\n\n`,
                ));
                // Fall back to Ollama
                resolvedMainModel = null;
            }
        }

        try {
            if (resolvedMainModel) {
                // Generate via VS Code model API
                const vscodeMessages = convertToVscodeMessages(messages, memoryText);
                response = await sendToVscodeModel(resolvedMainModel, vscodeMessages, token);
            } else {
                // Generate via Ollama
                const ollamaMessages = convertToOllamaMessages(messages, memoryText);
                response = await ollamaChat(ollamaUrl, ollamaModel, ollamaMessages, token);
            }
        } catch (err: any) {
            const source = resolvedMainModel ? mainModelSetting : `Ollama ${ollamaModel}`;
            progress.report(new vscode.LanguageModelTextPart(
                `❌ ${source} request failed: ${err.message ?? err}`,
            ));
            return;
        }

        if (token.isCancellationRequested) return;

        // ── Step 2: If validation disabled or no memory, stream directly ─

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

        // ── Step 3: Validate against project memory (always Ollama) ─────

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
            progress.report(new vscode.LanguageModelTextPart(response));
            if (showBadges) {
                progress.report(new vscode.LanguageModelTextPart(
                    "\n\n---\n⚠️ *aisanity validation unavailable — response not checked*\n",
                ));
            }
            return;
        }

        if (token.isCancellationRequested) return;

        // ── Step 4a: Clean — stream original ────────────────────────────

        if (verdict.is_valid) {
            progress.report(new vscode.LanguageModelTextPart(response));
            if (showBadges) {
                const src = resolvedMainModel ? mainModelSetting : `Ollama ${ollamaModel}`;
                progress.report(new vscode.LanguageModelTextPart(
                    `\n\n---\n✅ *Validated by aisanity — generated by ${src}, complies with project memory*\n`,
                ));
            }
            return;
        }

        // ── Step 4b: Violations — report them ───────────────────────────

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

        if (!enableAutoCorrection || maxRetries === 0) {
            progress.report(new vscode.LanguageModelTextPart(response));
            if (showBadges) {
                progress.report(new vscode.LanguageModelTextPart(
                    "\n\n---\n⚠️ *Auto-correction disabled — review violations above manually*\n",
                ));
            }
            return;
        }

        // ── Step 5: Auto-correct loop ───────────────────────────────────
        // Correction goes back to the SAME main model that generated the
        // original response — so it can fix its own mistakes.

        let currentResponse = response;
        let currentVerdict = verdict;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (token.isCancellationRequested) return;

            const violationsSummary = currentVerdict.violations
                .map(
                    (v, i) =>
                        `${i + 1}. [${v.rule}] Used \`${v.found}\` but should use \`${v.expected}\` — ${v.explanation}`,
                )
                .join("\n");

            const correctionPrompt =
                `Your previous response has these violations of the project rules:\n\n` +
                `${violationsSummary}\n\n` +
                `Provide a CORRECTED response that fixes ALL violations. ` +
                `Follow every rule in the project memory strictly. ` +
                `Do not apologize or explain what changed — just give the corrected response.`;

            let corrected: string;
            try {
                if (resolvedMainModel) {
                    // Correct via the same VS Code model
                    const correctionMessages = convertToVscodeMessages(messages, memoryText);
                    correctionMessages.push(
                        vscode.LanguageModelChatMessage.Assistant(currentResponse),
                    );
                    correctionMessages.push(
                        vscode.LanguageModelChatMessage.User(correctionPrompt),
                    );
                    corrected = await sendToVscodeModel(resolvedMainModel, correctionMessages, token);
                } else {
                    // Correct via Ollama
                    const ollamaMessages = convertToOllamaMessages(messages, memoryText);
                    const correctionMessages: OllamaMessage[] = [
                        ...ollamaMessages,
                        { role: "assistant", content: currentResponse },
                        { role: "user", content: correctionPrompt },
                    ];
                    corrected = await ollamaChat(ollamaUrl, ollamaModel, correctionMessages, token);
                }
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
                    progress.report(new vscode.LanguageModelTextPart(corrected));
                    if (showBadges) {
                        progress.report(new vscode.LanguageModelTextPart(
                            `\n\n---\n✅ *Corrected and validated by aisanity (attempt ${attempt + 1}) — now complies with project memory*\n`,
                        ));
                    }
                    return;
                }

                currentResponse = corrected;
                currentVerdict = recheck;
            } catch {
                progress.report(new vscode.LanguageModelTextPart(corrected));
                if (showBadges) {
                    progress.report(new vscode.LanguageModelTextPart(
                        "\n\n---\n⚡ *Corrected by aisanity (re-validation skipped)*\n",
                    ));
                }
                return;
            }
        }

        // Exhausted retries
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
