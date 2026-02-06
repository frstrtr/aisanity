#!/usr/bin/env node
/**
 * aisanity MCP Server — pure TypeScript
 *
 * Model Context Protocol server that exposes aisanity validation as MCP tools.
 * Runs over stdio using JSON-RPC 2.0. Zero external dependencies.
 *
 * Usage:
 *   node mcp_server.js [--memory .ai-memory.md] [--ollama-url URL] [--ollama-model MODEL]
 */

import {
    MemoryGuardian,
    formatVerdict,
    DEFAULTS,
    type Verdict,
} from "./guardian";

// ── MCP Protocol Constants ──────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = "2024-11-05";

const SERVER_INFO = {
    name: "aisanity",
    version: "0.1.0",
};

const SERVER_CAPABILITIES = {
    tools: {},
};

const TOOLS = [
    {
        name: "aisanity_validate",
        description:
            "Validate an AI-generated suggestion (code, command, or advice) against " +
            "the project's .ai-memory.md memory file. Returns pass/fail verdict with " +
            "specific violations. Call this BEFORE finalizing any response that contains " +
            "code, shell commands, architecture advice, or tool recommendations.",
        inputSchema: {
            type: "object",
            properties: {
                suggestion: {
                    type: "string",
                    description:
                        "The AI-generated suggestion to validate. Can be a shell command, " +
                        "code snippet, multi-line code block, or free-text advice.",
                },
            },
            required: ["suggestion"],
        },
    },
    {
        name: "aisanity_fix",
        description:
            "Validate a suggestion AND generate a correction prompt if violations are " +
            "found. Use this when you want to self-correct — it returns specific " +
            "instructions on how to fix the violations.",
        inputSchema: {
            type: "object",
            properties: {
                suggestion: {
                    type: "string",
                    description: "The AI-generated suggestion to validate and fix.",
                },
            },
            required: ["suggestion"],
        },
    },
    {
        name: "aisanity_memory",
        description:
            "Read the project's .ai-memory.md memory file to understand project-specific " +
            "requirements, forbidden patterns, and common mistakes. Call this at the start " +
            "of a conversation or when unsure about project constraints.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
];

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────

function log(msg: string): void {
    process.stderr.write(`[aisanity-mcp] ${msg}\n`);
}

function send(message: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(message) + "\n");
}

function respond(requestId: unknown, result: Record<string, unknown>): void {
    send({ jsonrpc: "2.0", id: requestId, result });
}

function respondError(requestId: unknown, code: number, message: string): void {
    send({ jsonrpc: "2.0", id: requestId, error: { code, message } });
}

function toolResult(text: string, isError = false): Record<string, unknown> {
    return {
        content: [{ type: "text", text }],
        isError,
    };
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function handleValidate(
    guardian: MemoryGuardian,
    args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const suggestion = (args.suggestion as string) ?? "";
    if (!suggestion.trim()) {
        return toolResult("Error: empty suggestion provided", true);
    }

    const verdict = await guardian.validate(suggestion);
    let text = formatVerdict(verdict);

    // Append structured JSON for the AI to parse
    text += `\n\n<verdict_json>\n${JSON.stringify(verdict, null, 2)}\n</verdict_json>`;

    return toolResult(text);
}

async function handleFix(
    guardian: MemoryGuardian,
    args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const suggestion = (args.suggestion as string) ?? "";
    if (!suggestion.trim()) {
        return toolResult("Error: empty suggestion provided", true);
    }

    const verdict = await guardian.validate(suggestion);
    let text = formatVerdict(verdict);

    if (!verdict.is_valid && verdict.violations.length > 0) {
        const correction = await guardian.generateCorrection(suggestion, verdict);
        if (correction) {
            const border = "━".repeat(55);
            text +=
                `\n\n📝 CORRECTION INSTRUCTIONS:\n${border}\n` +
                `${correction}\n${border}\n` +
                `\nApply these corrections to your response before presenting it to the user.`;
        }
    }

    return toolResult(text);
}

async function handleMemory(
    guardian: MemoryGuardian,
    _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    return toolResult(guardian.showMemory());
}

const TOOL_HANDLERS: Record<
    string,
    (g: MemoryGuardian, a: Record<string, unknown>) => Promise<Record<string, unknown>>
> = {
    aisanity_validate: handleValidate,
    aisanity_fix: handleFix,
    aisanity_memory: handleMemory,
};

// ── MCP Message Router ──────────────────────────────────────────────────────

async function handleMessage(
    msg: Record<string, unknown>,
    guardian: MemoryGuardian,
): Promise<void> {
    const method = msg.method as string | undefined;
    const requestId = msg.id;
    const params = (msg.params as Record<string, unknown>) ?? {};

    // ── Initialize
    if (method === "initialize") {
        log("Client connected — initializing");
        respond(requestId, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: SERVER_CAPABILITIES,
            serverInfo: SERVER_INFO,
        });
        return;
    }

    // ── Notifications (no response needed)
    if (method === "notifications/initialized") {
        log("Client initialized — ready");
        return;
    }
    if (method === "notifications/cancelled") {
        log(`Request cancelled: ${params.requestId}`);
        return;
    }

    // ── List tools
    if (method === "tools/list") {
        respond(requestId, { tools: TOOLS });
        return;
    }

    // ── Call tool
    if (method === "tools/call") {
        const toolName = (params.name as string) ?? "";
        const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

        const handler = TOOL_HANDLERS[toolName];
        if (!handler) {
            respondError(requestId!, -32602, `Unknown tool: ${toolName}`);
            return;
        }

        log(`Tool call: ${toolName}`);
        try {
            const result = await handler(guardian, toolArgs);
            respond(requestId, result);
        } catch (err: any) {
            log(`Tool error: ${err.message ?? err}`);
            respond(requestId, toolResult(`Error: ${err.message ?? err}`, true));
        }
        return;
    }

    // ── Ping
    if (method === "ping") {
        respond(requestId, {});
        return;
    }

    // ── Unknown method
    if (requestId != null) {
        respondError(requestId, -32601, `Method not found: ${method}`);
    }
}

// ── Arg Parser ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith("--") && i + 1 < argv.length) {
            const key = arg.slice(2); // strip --
            result[key] = argv[++i];
        }
    }
    return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
    const args = parseArgs(process.argv.slice(2));

    const guardian = new MemoryGuardian({
        memoryFile: args["memory"] ?? DEFAULTS.memoryFile,
        ollamaUrl: args["ollama-url"] ?? DEFAULTS.ollamaUrl,
        ollamaModel: args["ollama-model"] ?? DEFAULTS.ollamaModel,
        githubModel: args["github-model"] ?? DEFAULTS.githubModel,
        githubToken: process.env.GITHUB_TOKEN,
        log,
    });

    log(
        `Server started — memory: ${args["memory"] ?? DEFAULTS.memoryFile}, ` +
        `ollama: ${args["ollama-url"] ?? DEFAULTS.ollamaUrl}/${args["ollama-model"] ?? DEFAULTS.ollamaModel}`,
    );

    // Read JSON-RPC messages from stdin, one per line
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop()!; // keep incomplete last line
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg = JSON.parse(trimmed);
                handleMessage(msg, guardian).catch((err) => {
                    log(`Unhandled error: ${err.message ?? err}`);
                });
            } catch (err: any) {
                log(`Invalid JSON: ${err.message}`);
                send({
                    jsonrpc: "2.0",
                    id: null,
                    error: { code: -32700, message: `Parse error: ${err.message}` },
                });
            }
        }
    });

    process.stdin.on("end", () => {
        log("stdin closed — shutting down");
        process.exit(0);
    });
}

// Allow both direct execution and import
if (require.main === module) {
    main();
}

export { main as startMcpServer };
