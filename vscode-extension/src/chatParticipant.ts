/**
 * aisanity Chat Participant — @aisanity intercepting proxy
 *
 * When the user types `@aisanity <question>`, this participant:
 * 1. Forwards the question to the main Copilot model
 * 2. Collects the FULL response
 * 3. Validates it against .ai-memory.md using the local Ollama guardian
 * 4. If violations found → asks the model to fix them → streams corrected version
 * 5. If clean → streams the original response
 *
 * This is a true intercepting proxy — the model CANNOT bypass validation.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { MemoryGuardian, formatVerdict, type Verdict } from "./guardian";

// ── Helpers ─────────────────────────────────────────────────────────────────

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("aisanity");
}

function findMemoryFile(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return undefined;
    const name = getConfig().get<string>("memoryFile", ".ai-memory.md");
    for (const f of folders) {
        const p = require("path").join(f.uri.fsPath, name);
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

function createGuardian(memoryPath: string): MemoryGuardian {
    const config = getConfig();
    return new MemoryGuardian({
        memoryFile: memoryPath,
        ollamaUrl: config.get<string>("ollamaUrl"),
        ollamaModel: config.get<string>("ollamaModel"),
        githubModel: config.get<string>("githubModel"),
        githubToken: process.env.GITHUB_TOKEN,
    });
}

/** Build chat history from context for multi-turn conversations. */
function buildHistory(
    context: vscode.ChatContext,
): vscode.LanguageModelChatMessage[] {
    const msgs: vscode.LanguageModelChatMessage[] = [];
    for (const turn of context.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
            msgs.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
            let text = "";
            for (const part of turn.response) {
                if (part instanceof vscode.ChatResponseMarkdownPart) {
                    text += part.value.value;
                }
            }
            if (text) {
                msgs.push(vscode.LanguageModelChatMessage.Assistant(text));
            }
        }
    }
    return msgs;
}

/** Collect the full text from a streamed model response. */
async function collectResponse(
    response: vscode.LanguageModelChatResponse,
): Promise<string> {
    let full = "";
    for await (const chunk of response.text) {
        full += chunk;
    }
    return full;
}

/** Format violations into a compact markdown block. */
function formatViolationsMarkdown(verdict: Verdict): string {
    const lines: string[] = [
        "",
        "---",
        "⚠️ **aisanity intercepted violations** — auto-correcting…\n",
    ];
    for (const v of verdict.violations) {
        lines.push(`- **${v.rule}**: found \`${v.found}\` → expected \`${v.expected}\` — ${v.explanation}`);
    }
    lines.push("");
    lines.push(`*\\[validator: ${verdict.backend} / ${verdict.model}\\]*`);
    lines.push("");
    lines.push("---");
    lines.push("");
    return lines.join("\n");
}

// ── Chat Participant Handler ────────────────────────────────────────────────

export const chatHandler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
): Promise<vscode.ChatResult> => {
    const memoryPath = findMemoryFile();

    // ── No memory file → pass through with a note
    if (!memoryPath) {
        stream.markdown(
            "⚠️ *No `.ai-memory.md` found in workspace — " +
            "running without aisanity validation. " +
            "Use `aisanity: Init Project` to create one.*\n\n",
        );
        const history = buildHistory(context);
        history.push(vscode.LanguageModelChatMessage.User(request.prompt));
        const resp = await request.model.sendRequest(history, {}, token);
        for await (const chunk of resp.text) {
            stream.markdown(chunk);
        }
        return {};
    }

    const guardian = createGuardian(memoryPath);
    const memoryText = guardian.showMemory();

    // ── Step 1: Build messages with memory context injected
    stream.progress("Generating response…");

    const systemPreamble =
        `You are a helpful coding assistant. The following project memory ` +
        `defines rules you MUST follow. Read it carefully and comply with ` +
        `every requirement.\n\n---\n${memoryText}\n---\n\n` +
        `Now answer the user's question while strictly following the above rules.`;

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPreamble),
    ];

    // Add conversation history
    messages.push(...buildHistory(context));

    // Add current request
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    // ── Step 2: Get the model's full response (don't stream yet)
    let modelResponse: string;
    try {
        const resp = await request.model.sendRequest(messages, {}, token);
        modelResponse = await collectResponse(resp);
    } catch (err: any) {
        stream.markdown(`❌ Model request failed: ${err.message ?? err}`);
        return { metadata: { error: true } };
    }

    if (token.isCancellationRequested) {
        return { metadata: { cancelled: true } };
    }

    // ── Step 3: Validate against project memory via Ollama
    stream.progress("Validating against project memory…");

    let verdict: Verdict;
    try {
        verdict = await guardian.validate(modelResponse);
    } catch (err: any) {
        // Validation infra failed — show original response with warning
        stream.markdown(
            "⚠️ *aisanity validation unavailable — showing unvalidated response.*\n\n",
        );
        stream.markdown(modelResponse);
        return { metadata: { validationError: String(err) } };
    }

    if (token.isCancellationRequested) {
        return { metadata: { cancelled: true } };
    }

    // ── Step 4a: Clean — stream the original response
    if (verdict.is_valid) {
        stream.markdown(modelResponse);
        stream.markdown(
            "\n\n---\n✅ *Validated by aisanity — complies with project memory*\n",
        );
        return { metadata: { validated: true, violations: 0 } };
    }

    // ── Step 4b: Violations found — auto-correct
    stream.progress(
        `Found ${verdict.violations.length} violation(s) — requesting correction…`,
    );

    // Show what was caught
    stream.markdown(formatViolationsMarkdown(verdict));

    // Build correction request
    const violationsSummary = verdict.violations
        .map(
            (v, i) =>
                `${i + 1}. [${v.rule}] You used \`${v.found}\` but should use \`${v.expected}\` — ${v.explanation}`,
        )
        .join("\n");

    const correctionMessages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPreamble),
        ...buildHistory(context),
        vscode.LanguageModelChatMessage.User(request.prompt),
        vscode.LanguageModelChatMessage.Assistant(modelResponse),
        vscode.LanguageModelChatMessage.User(
            `Your previous response has the following violations of the project memory rules:\n\n` +
            `${violationsSummary}\n\n` +
            `Please provide a CORRECTED response that fixes ALL violations. ` +
            `Follow every rule in the project memory strictly. ` +
            `Do not apologize or explain what changed — just give the corrected response.`,
        ),
    ];

    // ── Step 5: Stream the corrected response
    try {
        const correctedResp = await request.model.sendRequest(
            correctionMessages,
            {},
            token,
        );

        // Collect to re-validate
        let correctedText = "";
        for await (const chunk of correctedResp.text) {
            correctedText += chunk;
            stream.markdown(chunk);
        }

        // ── Step 6: Re-validate the correction (non-blocking, just informational)
        try {
            const recheck = await guardian.validate(correctedText);
            if (recheck.is_valid) {
                stream.markdown(
                    "\n\n---\n✅ *Corrected and validated by aisanity — now complies with project memory*\n",
                );
            } else {
                const remaining = recheck.violations
                    .map((v) => `\`${v.rule}\`: ${v.explanation}`)
                    .join(", ");
                stream.markdown(
                    `\n\n---\n⚠️ *aisanity: ${recheck.violations.length} issue(s) may remain after correction: ${remaining}. ` +
                    `Review manually or ask again.*\n`,
                );
            }
        } catch {
            stream.markdown(
                "\n\n---\n⚡ *Corrected by aisanity (re-validation skipped)*\n",
            );
        }

        return {
            metadata: {
                validated: true,
                violations: verdict.violations.length,
                corrected: true,
            },
        };
    } catch (err: any) {
        // Correction failed — show original with violations listed
        stream.markdown(`\n\n❌ *Correction request failed: ${err.message ?? err}*\n`);
        stream.markdown("\n**Original (unvalidated) response:**\n\n");
        stream.markdown(modelResponse);
        return {
            metadata: {
                validated: true,
                violations: verdict.violations.length,
                corrected: false,
            },
        };
    }
};
