#!/usr/bin/env python3
"""
aisanity MCP Server — Model Context Protocol server for AI Memory Guardian.

Exposes aisanity validation and context compression as MCP tools that AI agents
(Claude, Copilot, etc.) can call automatically during conversations.
Runs over stdio using JSON-RPC 2.0.

Zero external dependencies — stdlib only. Imports from guardian.py.

Usage:
    python3 mcp_server.py [--memory .ai-memory.md] [--ollama-url URL] [--ollama-model MODEL]
"""

import json
import sys
import os
import argparse
import urllib.error
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from guardian import (
    MemoryGuardian,
    ContextCompressor,
    format_verdict,
    format_compression,
    MEMORY_FILE,
    OLLAMA_URL,
    OLLAMA_MODEL,
    GITHUB_MODEL,
)


# ── MCP Protocol Constants ──────────────────────────────────────────────────

MCP_PROTOCOL_VERSION = "2024-11-05"

SERVER_INFO = {
    "name": "aisanity",
    "version": "0.2.0",
}

SERVER_CAPABILITIES = {
    "tools": {},
}

TOOLS = [
    {
        "name": "aisanity_validate",
        "description": (
            "Validate an AI-generated suggestion (code, command, or advice) against "
            "the project's .ai-memory.md memory file. Returns pass/fail verdict with "
            "specific violations. Call this BEFORE finalizing any response that contains "
            "code, shell commands, architecture advice, or tool recommendations."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "suggestion": {
                    "type": "string",
                    "description": (
                        "The AI-generated suggestion to validate. Can be a shell command, "
                        "code snippet, multi-line code block, or free-text advice."
                    ),
                },
            },
            "required": ["suggestion"],
        },
    },
    {
        "name": "aisanity_fix",
        "description": (
            "Validate a suggestion AND generate a correction prompt if violations are "
            "found. Use this when you want to self-correct — it returns specific "
            "instructions on how to fix the violations."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "suggestion": {
                    "type": "string",
                    "description": "The AI-generated suggestion to validate and fix.",
                },
            },
            "required": ["suggestion"],
        },
    },
    {
        "name": "aisanity_memory",
        "description": (
            "Read the project's .ai-memory.md memory file to understand project-specific "
            "requirements, forbidden patterns, and common mistakes. Call this at the start "
            "of a conversation or when unsure about project constraints."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "aisanity_compress",
        "description": (
            "Compress a large context payload using a local Ollama model (devstral:24b) "
            "before sending it to Claude API. Use this when your context is approaching "
            "the Claude context window limit (192K on Copilot, 200K on API Tier 1-3). "
            "\n\n"
            "What gets compressed:\n"
            "- Unchanged files → replaced with 1-line summaries\n"
            "- Build artifacts and generated headers → dropped\n"
            "- Conversation history → decisions kept, verbose back-and-forth dropped\n"
            "- Tool results → conclusions kept, raw output dropped\n"
            "\n"
            "What is NEVER touched:\n"
            "- Current task and user's last instruction\n"
            "- Code currently being written or reviewed\n"
            "- All error messages and stack traces\n"
            "- All explicit user constraints and decisions\n"
            "\n"
            "Returns the compressed context ready to paste into a new Claude session. "
            "Typical savings: 40-70% token reduction. "
            "Processing happens 100% locally via your Ollama server — no API cost."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "context": {
                    "type": "string",
                    "description": (
                        "The full context payload to compress. Paste everything here: "
                        "file contents, conversation history, tool outputs, error logs. "
                        "The more complete the input, the better the compression decisions."
                    ),
                },
                "hint": {
                    "type": "string",
                    "description": (
                        "Optional: describe what task you're about to continue in the new "
                        "session. This helps the compressor decide what to keep vs drop. "
                        "Example: 'I'm about to refactor the networking module' or "
                        "'debugging a segfault in the mining thread'."
                    ),
                },
            },
            "required": ["context"],
        },
    },
]


# ── JSON-RPC over stdio ─────────────────────────────────────────────────────

def _log(msg: str) -> None:
    """Log to stderr (stdout is reserved for MCP protocol)."""
    print(f"[aisanity-mcp] {msg}", file=sys.stderr, flush=True)


def _send(message: dict) -> None:
    """Send a JSON-RPC message to stdout."""
    line = json.dumps(message, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _respond(request_id, result: dict) -> None:
    """Send a JSON-RPC success response."""
    _send({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result,
    })


def _respond_error(request_id, code: int, message: str) -> None:
    """Send a JSON-RPC error response."""
    _send({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    })


def _tool_result(text: str, is_error: bool = False) -> dict:
    """Format a tool call result per MCP spec."""
    return {
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    }


# ── Tool Handlers ────────────────────────────────────────────────────────────

def handle_validate(guardian: MemoryGuardian, args: dict) -> dict:
    suggestion = args.get("suggestion", "")
    if not suggestion.strip():
        return _tool_result("Error: empty suggestion provided", is_error=True)

    verdict = guardian.validate(suggestion)
    text = format_verdict(verdict)

    verdict_data = asdict(verdict)
    verdict_data["violations"] = [asdict(v) for v in verdict.violations]
    text += f"\n\n<verdict_json>\n{json.dumps(verdict_data, indent=2)}\n</verdict_json>"

    return _tool_result(text)


def handle_fix(guardian: MemoryGuardian, args: dict) -> dict:
    suggestion = args.get("suggestion", "")
    if not suggestion.strip():
        return _tool_result("Error: empty suggestion provided", is_error=True)

    verdict = guardian.validate(suggestion)
    text = format_verdict(verdict)

    if not verdict.is_valid and verdict.violations:
        correction = guardian.generate_correction(suggestion, verdict)
        if correction:
            text += (
                f"\n\n📝 CORRECTION INSTRUCTIONS:\n"
                f"{'━' * 55}\n"
                f"{correction}\n"
                f"{'━' * 55}\n"
                f"\nApply these corrections to your response before presenting it to the user."
            )

    return _tool_result(text)


def handle_memory(guardian: MemoryGuardian, _args: dict) -> dict:
    memory = guardian.show_memory()
    return _tool_result(memory)


def handle_compress(compressor: ContextCompressor, args: dict) -> dict:
    """Handle aisanity_compress tool call."""
    context = args.get("context", "")
    hint = args.get("hint", "")

    if not context.strip():
        return _tool_result("Error: empty context provided", is_error=True)

    # Prepend hint to context so the compressor knows what to prioritize
    if hint.strip():
        augmented = (
            f"[COMPRESSION HINT: {hint.strip()}]\n\n"
            f"{context}"
        )
    else:
        augmented = context

    _log(f"Compression requested — input ~{len(context)//4:,} tokens")

    result = compressor.compress(augmented)
    text = format_compression(result)

    # Append stats as structured data for the AI
    stats = {
        "original_tokens": result.original_tokens,
        "compressed_tokens": result.compressed_tokens,
        "savings_pct": result.savings_pct,
        "backend": result.backend,
        "model": result.model,
        "error": result.error,
    }
    text += f"\n\n<compression_stats>\n{json.dumps(stats, indent=2)}\n</compression_stats>"

    _log(f"Compression done — {result.original_tokens:,} → {result.compressed_tokens:,} tokens ({result.savings_pct}% saved)")

    return _tool_result(text, is_error=bool(result.error and not result.compressed))


# ── MCP Message Router ──────────────────────────────────────────────────────

def handle_message(msg: dict, guardian: MemoryGuardian, compressor: ContextCompressor) -> None:
    """Route an incoming JSON-RPC message to the appropriate handler."""
    method = msg.get("method")
    request_id = msg.get("id")
    params = msg.get("params", {})

    if method == "initialize":
        _log("Client connected — initializing")
        _respond(request_id, {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": SERVER_CAPABILITIES,
            "serverInfo": SERVER_INFO,
        })
        return

    if method == "notifications/initialized":
        _log("Client initialized — ready")
        return
    if method == "notifications/cancelled":
        _log(f"Request cancelled: {params.get('requestId')}")
        return

    if method == "tools/list":
        _respond(request_id, {"tools": TOOLS})
        return

    if method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})

        _log(f"Tool call: {tool_name}")

        try:
            if tool_name == "aisanity_validate":
                result = handle_validate(guardian, tool_args)
            elif tool_name == "aisanity_fix":
                result = handle_fix(guardian, tool_args)
            elif tool_name == "aisanity_memory":
                result = handle_memory(guardian, tool_args)
            elif tool_name == "aisanity_compress":
                result = handle_compress(compressor, tool_args)
            else:
                _respond_error(request_id, -32602, f"Unknown tool: {tool_name}")
                return

            _respond(request_id, result)

        except (urllib.error.URLError, OSError, json.JSONDecodeError,
                RuntimeError, ValueError, KeyError) as exc:
            _log(f"Tool error: {exc}")
            _respond(request_id, _tool_result(f"Error: {exc}", is_error=True))
        return

    if method == "ping":
        _respond(request_id, {})
        return

    if request_id is not None:
        _respond_error(request_id, -32601, f"Method not found: {method}")


# ── Main Loop ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="aisanity MCP Server")
    parser.add_argument("--memory", default=MEMORY_FILE, help="Path to memory file")
    parser.add_argument("--ollama-url", default=OLLAMA_URL, help="Ollama server URL")
    parser.add_argument("--ollama-model", default=OLLAMA_MODEL, help="Ollama model")
    parser.add_argument("--github-model", default=GITHUB_MODEL, help="GitHub fallback model")
    args = parser.parse_args()

    github_token = os.environ.get("GITHUB_TOKEN")

    guardian = MemoryGuardian(
        memory_file=args.memory,
        ollama_url=args.ollama_url,
        ollama_model=args.ollama_model,
        github_model=args.github_model,
        github_token=github_token,
    )

    compressor = ContextCompressor(
        ollama_url=args.ollama_url,
        ollama_model=args.ollama_model,
        github_model=args.github_model,
        github_token=github_token,
    )

    _log(
        f"Server started v0.2.0 — memory: {args.memory}, "
        f"ollama: {args.ollama_url}/{args.ollama_model}"
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            handle_message(msg, guardian, compressor)
        except json.JSONDecodeError as exc:
            _log(f"Invalid JSON: {exc}")
            _send({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {exc}"},
            })

    _log("stdin closed — shutting down")


if __name__ == "__main__":
    main()
