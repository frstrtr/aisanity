/**
 * aisanity Language Model Provider — appears in the VS Code model dropdown
 *
 * When the user selects "aisanity" as their model in the chat model picker,
 * EVERY request from ANY participant gets proxied through validation:
 *
 *   1. Injects project memory into the system context
 *   2. Forwards to the "main model" for generation:
 *      - copilot:claude-opus-4.6 (default) → VS Code model API
 *      - ollama → direct Ollama HTTP call
 *   3. Validates the full response against .ai-memory.md (always via Ollama)
 *   4. If violations → auto-corrects and re-validates (configurable)
 *   5. Streams the validated (or corrected) response back
 *
 * Key setting: aisanity.mainModel
 *   - "copilot:claude-opus-4.6" (default) → Claude Opus 4.6 generates, Ollama validates
 *   - "copilot:gpt-5.1"  → Copilot GPT-5.1 generates, Ollama validates
 *   - "ollama" → Ollama does both generation + validation
 *   - Any VS Code model ID → that model generates, Ollama validates
 *
 * Checker/validator: always Ollama (default: devstral:24b)
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

// ── Ollama /api/show — query model metadata ─────────────────────────────────

interface OllamaModelInfo {
    contextLength: number;
}

/**
 * Call Ollama /api/show to get model metadata (context window, etc.).
 * Returns defaults on any failure — never throws.
 */
function ollamaShow(baseUrl: string, model: string): Promise<OllamaModelInfo> {
    const FALLBACK: OllamaModelInfo = { contextLength: 128_000 };

    return new Promise((resolve) => {
        try {
            const parsed = new URL(`${baseUrl}/api/show`);
            const isHttps = parsed.protocol === "https:";
            const mod = isHttps ? https : http;

            const payload = JSON.stringify({ model });

            const reqOpts: http.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                },
                timeout: 10_000,
            };

            const req = mod.request(reqOpts, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    try {
                        const body = Buffer.concat(chunks).toString("utf-8");
                        const data = JSON.parse(body);
                        const info = data.model_info ?? {};

                        // Key varies by architecture: llama.context_length,
                        // gemma3.context_length, qwen2.context_length, etc.
                        let ctx = 0;
                        for (const key of Object.keys(info)) {
                            if (key.endsWith(".context_length") && typeof info[key] === "number") {
                                ctx = info[key];
                                break;
                            }
                        }

                        resolve({ contextLength: ctx || FALLBACK.contextLength });
                    } catch {
                        resolve(FALLBACK);
                    }
                });
            });

            req.on("error", () => resolve(FALLBACK));
            req.on("timeout", () => { req.destroy(); resolve(FALLBACK); });
            req.write(payload);
            req.end();
        } catch {
            resolve(FALLBACK);
        }
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
    /** For vscode-model: the raw model ID string (e.g. "copilot:claude-opus-4.6") */
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

    // Format: "vendor:family" (e.g. "copilot:claude-opus-4.6") or just a model ID
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
        const mainModelSetting = config.get<string>("mainModel", "copilot:claude-opus-4.6");
        const { url: ollamaUrl, model: ollamaModel } = resolveOllamaConfig(this._groupConfig);

        const mainSelector = parseMainModel(mainModelSetting);

        // ── Dynamically resolve token limits from the underlying model ──
        let maxInput = 128_000;  // safe fallback
        let maxOutput = 128_000;
        let hasToolCalling = true;
        let hasImageInput = false;

        if (mainSelector.kind === "vscode-model") {
            // Query the VS Code model API for its real limits
            const resolved = await resolveVscodeModel(mainSelector);
            if (resolved) {
                maxInput = resolved.maxInputTokens;
                // VS Code LanguageModelChat doesn't expose maxOutputTokens,
                // so estimate as a fraction of input or use a generous default
                maxOutput = maxInput;
            }
        } else {
            // Query Ollama /api/show for the model's actual context window
            const info = await ollamaShow(ollamaUrl, ollamaModel);
            maxInput = info.contextLength;
            // Ollama models typically produce up to ~4K output tokens,
            // but the limit is the full context window
            maxOutput = Math.min(info.contextLength, 32_768);
        }

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
                version: "0.6.3",
                tooltip: "Proxies through a main model with automatic project memory validation via Ollama",
                detail: modelDetail,
                maxInputTokens: maxInput,
                maxOutputTokens: maxOutput,
                capabilities: {
                    toolCalling: hasToolCalling,
                    imageInput: hasImageInput,
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

        const mainModelSetting = config.get<string>("mainModel", "copilot:claude-opus-4.6");

        // ── Intercept "Health Check" queries ────────────────────────────
        if (this._isHealthCheckQuery(messages)) {
            await this._handleHealthCheck(progress, token, config, mainModelSetting, ollamaUrl, ollamaModel);
            return;
        }

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
                    `Use the format \`vendor:family\` (e.g. \`copilot:claude-opus-4.6\`, \`copilot:gpt-5.1\`), ` +
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

    // ── Health Check helpers ───────────────────────────────────────────

    /**
     * Detect if the user's last message is a health check request.
     */
    private _isHealthCheckQuery(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
    ): boolean {
        // Find the last user message
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === vscode.LanguageModelChatMessageRole.User) {
                let text = "";
                for (const part of messages[i].content) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        text += part.value;
                    }
                }
                const normalized = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
                return /^(aisanity\s+)?health\s*check$/.test(normalized)
                    || /^(aisanity\s+)?status$/.test(normalized);
            }
        }
        return false;
    }

    /**
     * Run an inline health check — reports model reachability and response
     * status directly into the chat stream.
     */
    private async _handleHealthCheck(
        progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
        token: vscode.CancellationToken,
        config: vscode.WorkspaceConfiguration,
        mainModelSetting: string,
        ollamaUrl: string,
        ollamaModel: string,
    ): Promise<void> {
        const emit = (text: string) => progress.report(new vscode.LanguageModelTextPart(text));

        emit("# aisanity Health Check\n\n");

        // ── 1. Memory file ──────────────────────────────────────────────
        const memoryPath = findMemoryFile();
        if (memoryPath) {
            const stat = fs.statSync(memoryPath);
            const sizeKb = (stat.size / 1024).toFixed(1);
            emit(`✅ **Memory file**: \`${memoryPath}\` (${sizeKb} KB)\n\n`);
        } else {
            emit("❌ **Memory file**: not found — run `aisanity: Init Project`\n\n");
        }

        // ── 2. Main model (generation) ──────────────────────────────────
        emit("## Main Model (generation)\n\n");
        emit(`ℹ️ **Configured**: \`${mainModelSetting}\`\n\n`);

        if (mainModelSetting === "ollama") {
            emit("ℹ️ Main model is Ollama — tested below with checker.\n\n");
        } else {
            // Try to resolve the VS Code model
            const selector = parseMainModel(mainModelSetting);
            const resolved = await resolveVscodeModel(selector);
            if (!resolved) {
                emit(`❌ **Resolved**: not found in VS Code model registry\n\n`);
                try {
                    const all = await vscode.lm.selectChatModels();
                    const copilotModels = all.filter(m => m.vendor === "copilot").slice(0, 8);
                    if (copilotModels.length > 0) {
                        emit("Available models:\n");
                        for (const m of copilotModels) {
                            emit(`- \`${m.vendor}:${m.family}\` — ${m.name}\n`);
                        }
                        emit("\n");
                    }
                } catch { /* ignore */ }
            } else {
                emit(`✅ **Resolved**: ${resolved.name} (\`${resolved.vendor}/${resolved.family}\`, ↓${resolved.maxInputTokens.toLocaleString()} tokens)\n\n`);

                // Live test — send a probe message
                if (!token.isCancellationRequested) {
                    emit("⏳ Sending test request…\n\n");
                    try {
                        const testMessages = [
                            vscode.LanguageModelChatMessage.User("Respond with exactly: AISANITY_OK"),
                        ];
                        const t0 = Date.now();
                        const resp = await resolved.sendRequest(testMessages, {}, token);
                        let reply = "";
                        for await (const chunk of resp.text) {
                            reply += chunk;
                            if (reply.length > 200) break;
                        }
                        const elapsed = Date.now() - t0;
                        const preview = reply.trim().slice(0, 80).replace(/\n/g, " ");
                        if (reply.toLowerCase().includes("aisanity_ok")) {
                            emit(`✅ **Test**: responded correctly in ${elapsed}ms — \`${preview}\`\n\n`);
                        } else {
                            emit(`⚠️ **Test**: responded in ${elapsed}ms but unexpected reply — \`${preview}\`\n\n`);
                        }
                    } catch (err: any) {
                        emit(`❌ **Test**: failed — ${err.message ?? err}\n\n`);
                    }
                }
            }
        }

        if (token.isCancellationRequested) return;

        // ── 3. Ollama checker (validation) ──────────────────────────────
        emit("## Checker Model (validation via Ollama)\n\n");
        emit(`ℹ️ **URL**: \`${ollamaUrl}\`\n`);
        emit(`ℹ️ **Model**: \`${ollamaModel}\`\n\n`);

        let ollamaReachable = false;
        let ollamaModelAvailable = false;

        // 3a. Check Ollama server reachability
        try {
            const parsed = new URL(`${ollamaUrl}/api/version`);
            const isHttps = parsed.protocol === "https:";
            const mod = isHttps ? https : http;

            const version = await new Promise<string>((resolve, reject) => {
                const req = mod.request(parsed, { method: "GET", timeout: 5000 }, (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => {
                        try {
                            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                            resolve(body.version ?? "unknown");
                        } catch { resolve("unknown"); }
                    });
                });
                req.on("error", reject);
                req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
                req.end();
            });
            ollamaReachable = true;
            emit(`✅ **Server**: reachable (v${version})\n`);
        } catch (err: any) {
            emit(`❌ **Server**: unreachable — ${err.message ?? err}\n\n`);
        }

        // 3b. Check model availability
        if (ollamaReachable) {
            try {
                const parsed = new URL(`${ollamaUrl}/api/show`);
                const isHttps = parsed.protocol === "https:";
                const mod = isHttps ? https : http;
                const payload = JSON.stringify({ model: ollamaModel });

                ollamaModelAvailable = await new Promise<boolean>((resolve) => {
                    const req = mod.request(parsed, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Content-Length": Buffer.byteLength(payload).toString(),
                        },
                        timeout: 5000,
                    }, (res) => {
                        res.resume();
                        res.on("end", () => resolve((res.statusCode ?? 500) < 400));
                    });
                    req.on("error", () => resolve(false));
                    req.on("timeout", () => { req.destroy(); resolve(false); });
                    req.write(payload);
                    req.end();
                });

                if (ollamaModelAvailable) {
                    emit(`✅ **Model \`${ollamaModel}\`**: available\n\n`);
                } else {
                    emit(`❌ **Model \`${ollamaModel}\`**: not found on server\n\n`);
                }
            } catch {
                emit(`❌ **Model \`${ollamaModel}\`**: check failed\n\n`);
            }
        }

        // 3c. Live inference test
        if (ollamaReachable && ollamaModelAvailable && !token.isCancellationRequested) {
            emit("⏳ Sending test inference to Ollama…\n\n");
            try {
                const t0 = Date.now();
                const reply = await ollamaChat(
                    ollamaUrl,
                    ollamaModel,
                    [{ role: "user", content: "Respond with exactly one word: AISANITY_OK" }],
                    token,
                );
                const elapsed = Date.now() - t0;
                const preview = reply.trim().slice(0, 80).replace(/\n/g, " ");

                if (reply.toLowerCase().includes("aisanity_ok")) {
                    emit(`✅ **Inference test**: responded correctly in ${(elapsed / 1000).toFixed(1)}s — \`${preview}\`\n\n`);
                } else {
                    emit(`⚠️ **Inference test**: responded in ${(elapsed / 1000).toFixed(1)}s but unexpected reply — \`${preview}\`\n\n`);
                }
            } catch (err: any) {
                emit(`❌ **Inference test**: failed — ${err.message ?? err}\n\n`);
            }
        } else if (!ollamaReachable || !ollamaModelAvailable) {
            emit("⏭️ **Inference test**: skipped (server/model unavailable)\n\n");
        }

        // ── 4. Settings summary ─────────────────────────────────────────
        emit("## Settings\n\n");
        emit("| Setting | Value |\n");
        emit("|---------|-------|\n");
        emit(`| enableValidation | ${config.get("enableValidation", true)} |\n`);
        emit(`| enableAutoCorrection | ${config.get("enableAutoCorrection", true)} |\n`);
        emit(`| maxCorrectionRetries | ${config.get("maxCorrectionRetries", 1)} |\n`);
        emit(`| showValidationBadges | ${config.get("showValidationBadges", true)} |\n`);
        emit(`| validationBackend | ${config.get("validationBackend", "ollama")} |\n\n`);

        // ── 5. Overall verdict ──────────────────────────────────────────
        emit("---\n\n");
        const hasMemory = !!memoryPath;
        const mainOk = mainModelSetting === "ollama" || (await resolveVscodeModel(parseMainModel(mainModelSetting))) !== null;
        const allOk = hasMemory && mainOk && ollamaReachable && ollamaModelAvailable;
        emit(allOk
            ? "## ✅ All systems operational\n"
            : "## ⚠️ Issues detected — review items above\n");
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
