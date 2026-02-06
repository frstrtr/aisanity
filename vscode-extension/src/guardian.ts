/**
 * aisanity — AI Memory Guardian (pure TypeScript)
 *
 * Validates AI suggestions against a plain-text project memory file
 * (.ai-memory.md). Uses a local Ollama server as the primary backend
 * and falls back to GitHub Models API (free via Copilot subscription).
 *
 * Zero external dependencies — Node.js built-ins only.
 */

import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULTS = {
    ollamaUrl: "http://192.168.86.45:11434",
    ollamaModel: "devstral:24b",
    githubModelsUrl: "https://models.github.ai/inference",
    githubModel: "openai/gpt-4o-mini",
    memoryFile: ".ai-memory.md",
    httpTimeout: 120_000, // ms — generous for cold model loads
} as const;

// ── Data Structures ─────────────────────────────────────────────────────────

export interface Violation {
    rule: string;
    found: string;
    expected: string;
    explanation: string;
}

export interface Verdict {
    is_valid: boolean;
    violations: Violation[];
    backend: string;
    model: string;
    error: string;
}

const VERDICT_SCHEMA = {
    type: "object",
    properties: {
        is_valid: { type: "boolean" },
        violations: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    rule: { type: "string" },
                    found: { type: "string" },
                    expected: { type: "string" },
                    explanation: { type: "string" },
                },
                required: ["rule", "found", "expected", "explanation"],
            },
        },
    },
    required: ["is_valid", "violations"],
};

// ── HTTP helper ─────────────────────────────────────────────────────────────

interface HttpOptions {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
}

function httpRequest(opts: HttpOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(opts.url);
        const isHttps = parsed.protocol === "https:";
        const mod = isHttps ? https : http;

        const reqOpts: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: opts.method || "GET",
            headers: opts.headers || {},
            timeout: opts.timeout ?? DEFAULTS.httpTimeout,
        };

        const req = mod.request(reqOpts, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf-8");
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
                } else {
                    resolve(body);
                }
            });
        });

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error(`Request timeout after ${reqOpts.timeout}ms`));
        });

        if (opts.body) {
            req.write(opts.body);
        }
        req.end();
    });
}

// ── LLM Backends ────────────────────────────────────────────────────────────

export interface LlmBackend {
    name: string;
    model: string;
    isAvailable(): Promise<boolean>;
    chat(system: string, user: string): Promise<string>;
}

export class OllamaBackend implements LlmBackend {
    readonly name = "ollama";
    private baseUrl: string;
    readonly model: string;

    constructor(baseUrl: string = DEFAULTS.ollamaUrl, model: string = DEFAULTS.ollamaModel) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.model = model;
    }

    async isAvailable(): Promise<boolean> {
        try {
            await httpRequest({
                url: `${this.baseUrl}/api/version`,
                timeout: 3000,
            });
            return true;
        } catch {
            return false;
        }
    }

    async chat(system: string, user: string): Promise<string> {
        const payload = JSON.stringify({
            model: this.model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            stream: false,
            format: VERDICT_SCHEMA,
            options: { temperature: 0.1 },
        });

        const body = await httpRequest({
            url: `${this.baseUrl}/api/chat`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
        });

        const result = JSON.parse(body);
        return result.message.content;
    }

    /** Freeform chat without structured output (for correction prompts). */
    async chatFreeform(system: string, user: string): Promise<string> {
        const payload = JSON.stringify({
            model: this.model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            stream: false,
            options: { temperature: 0.3 },
        });

        const body = await httpRequest({
            url: `${this.baseUrl}/api/chat`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
        });

        const result = JSON.parse(body);
        return result.message.content;
    }
}

export class GitHubModelsBackend implements LlmBackend {
    readonly name = "github-models";
    readonly model: string;
    private token: string;
    private baseUrl: string;

    constructor(model: string = DEFAULTS.githubModel, token?: string) {
        this.model = model;
        this.token = token || process.env.GITHUB_TOKEN || "";
        this.baseUrl = DEFAULTS.githubModelsUrl;
    }

    async isAvailable(): Promise<boolean> {
        return !!this.token;
    }

    async chat(system: string, user: string): Promise<string> {
        if (!this.token) {
            throw new Error("GITHUB_TOKEN environment variable is not set");
        }

        const payload = JSON.stringify({
            model: this.model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            temperature: 0.1,
            response_format: { type: "json_object" },
        });

        const body = await httpRequest({
            url: `${this.baseUrl}/chat/completions`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: payload,
        });

        const result = JSON.parse(body);
        return result.choices[0].message.content;
    }
}

// ── Prompts ─────────────────────────────────────────────────────────────────

function systemPrompt(memory: string): string {
    return `You are a Project Memory Guardian. Your job is to check whether an AI-generated
suggestion (a command, code snippet, or piece of advice) complies with the
project's documented requirements.

Here is the project memory — this is the ABSOLUTE SOURCE OF TRUTH:

---
${memory}
---

INSTRUCTIONS:
1. Read the suggestion carefully.
2. Compare it against EVERY rule, requirement, and forbidden pattern in the
   project memory above.
3. Identify ALL violations — even subtle or implied ones.
4. Return your verdict as JSON with this exact schema:
   {"is_valid": true/false, "violations": [...]}
   Each violation must have: "rule", "found", "expected", "explanation".
5. If the suggestion fully complies, return:
   {"is_valid": true, "violations": []}
6. Be strict. When in doubt, flag it.
7. Return ONLY the JSON object — no markdown, no commentary.`;
}

function correctionPrompt(memory: string, original: string, violations: string): string {
    return `You are a Project Memory Guardian. An AI assistant produced a response that
violates the project's documented requirements.

Here is the project memory — the ABSOLUTE SOURCE OF TRUTH:

---
${memory}
---

Here is the ORIGINAL AI RESPONSE that has violations:

---
${original}
---

Here are the VIOLATIONS found:

${violations}

INSTRUCTIONS:
1. Generate a CORRECTION PROMPT — a message that can be pasted back into the
   AI chat to instruct it to fix its response.
2. The correction prompt should:
   - List each violation clearly
   - Explain what was wrong and what the correct approach is
   - Reference the specific project rules
   - Ask the AI to revise its response
3. Write it in second person ("You used X, but you should use Y")
4. Be concise but complete.
5. Return ONLY the correction text — no JSON, no markdown fences.`;
}

// ── Guardian ────────────────────────────────────────────────────────────────

export interface GuardianOptions {
    memoryFile?: string;
    memoryText?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    githubModel?: string;
    githubToken?: string;
    log?: (msg: string) => void;
}

export class MemoryGuardian {
    private memoryText: string;
    private backends: LlmBackend[];
    private ollamaBackend: OllamaBackend;
    private log: (msg: string) => void;

    constructor(opts: GuardianOptions = {}) {
        this.log = opts.log ?? ((_msg: string) => {});

        // Load memory
        if (opts.memoryText !== undefined) {
            this.memoryText = opts.memoryText;
        } else {
            const memPath = opts.memoryFile ?? DEFAULTS.memoryFile;
            this.memoryText = fs.existsSync(memPath)
                ? fs.readFileSync(memPath, "utf-8")
                : "";
        }

        this.ollamaBackend = new OllamaBackend(
            opts.ollamaUrl ?? DEFAULTS.ollamaUrl,
            opts.ollamaModel ?? DEFAULTS.ollamaModel,
        );

        const githubBackend = new GitHubModelsBackend(
            opts.githubModel ?? DEFAULTS.githubModel,
            opts.githubToken,
        );

        this.backends = [this.ollamaBackend, githubBackend];
    }

    private parseVerdict(raw: string, backendName: string, model: string): Verdict {
        let data: any;
        try {
            data = JSON.parse(raw);
        } catch {
            // Try to extract JSON from markdown code fences
            const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (m) {
                data = JSON.parse(m[1]);
            } else {
                return {
                    is_valid: false,
                    violations: [],
                    backend: backendName,
                    model,
                    error: `Failed to parse LLM response as JSON: ${raw.slice(0, 200)}`,
                };
            }
        }

        const violations: Violation[] = (data.violations ?? []).map((v: any) => ({
            rule: v.rule ?? "unknown",
            found: v.found ?? "",
            expected: v.expected ?? "",
            explanation: v.explanation ?? "",
        }));

        return {
            is_valid: data.is_valid ?? violations.length === 0,
            violations,
            backend: backendName,
            model,
            error: "",
        };
    }

    async validate(suggestion: string): Promise<Verdict> {
        if (!this.memoryText) {
            return {
                is_valid: true,
                violations: [],
                backend: "",
                model: "",
                error: "No memory file loaded — nothing to validate against",
            };
        }

        const system = systemPrompt(this.memoryText);
        const user = `Check this AI suggestion for compliance:\n\n${suggestion}`;

        let lastError = "";
        for (const backend of this.backends) {
            if (!(await backend.isAvailable())) {
                lastError = `${backend.name}: not available`;
                this.log(`⏭  ${backend.name} not available, trying next…`);
                continue;
            }
            try {
                this.log(`🔍 Validating via ${backend.name} (${backend.model})…`);
                const raw = await backend.chat(system, user);
                return this.parseVerdict(raw, backend.name, backend.model);
            } catch (err: any) {
                lastError = `${backend.name}: ${err.message ?? err}`;
                this.log(`⚠️  ${backend.name} failed: ${err.message ?? err}`);
                continue;
            }
        }

        return {
            is_valid: false,
            violations: [],
            backend: "",
            model: "",
            error: `All backends failed. Last error: ${lastError}`,
        };
    }

    async generateCorrection(original: string, verdict: Verdict): Promise<string | null> {
        if (verdict.is_valid || verdict.violations.length === 0) {
            return null;
        }

        const violationsText = verdict.violations
            .map(
                (v, i) =>
                    `${i + 1}. [${v.rule}] Found: \`${v.found}\` → Expected: \`${v.expected}\` — ${v.explanation}`,
            )
            .join("\n");

        const system = correctionPrompt(this.memoryText, original, violationsText);
        const user = "Generate the correction prompt now.";

        // Try freeform chat (no structured schema)
        for (const backend of this.backends) {
            if (!(await backend.isAvailable())) {
                continue;
            }
            try {
                this.log(`📝 Generating correction via ${backend.name} (${backend.model})…`);
                if (backend instanceof OllamaBackend) {
                    return await backend.chatFreeform(system, user);
                }
                return await backend.chat(system, user);
            } catch (err: any) {
                this.log(`⚠️  ${backend.name} failed: ${err.message ?? err}`);
                continue;
            }
        }

        return null;
    }

    showMemory(): string {
        return this.memoryText || "No memory file loaded.";
    }
}

// ── Output formatting ───────────────────────────────────────────────────────

export function formatVerdict(verdict: Verdict): string {
    const lines: string[] = [];

    if (verdict.error) {
        lines.push(`⚠️  ERROR: ${verdict.error}`);
        return lines.join("\n");
    }

    if (verdict.is_valid) {
        lines.push("✅ PASSED — suggestion complies with project memory");
    } else {
        lines.push("❌ FAILED — violations detected!\n");
        verdict.violations.forEach((v, i) => {
            lines.push(`  Violation ${i + 1}:`);
            lines.push(`    Rule:        ${v.rule}`);
            lines.push(`    Found:       ${v.found}`);
            lines.push(`    Expected:    ${v.expected}`);
            lines.push(`    Explanation: ${v.explanation}`);
            lines.push("");
        });
    }

    lines.push(`  [backend: ${verdict.backend} | model: ${verdict.model}]`);
    return lines.join("\n");
}

export function formatCorrection(correction: string): string {
    const border = "━".repeat(55);
    return (
        `\n📝 CORRECTION PROMPT (paste this back to the AI):\n` +
        `${border}\n` +
        `${correction}\n` +
        `${border}`
    );
}
