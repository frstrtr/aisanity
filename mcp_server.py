#!/usr/bin/env python3
"""
aisanity MCP Server — Model Context Protocol server for AI Memory Guardian.

Exposes aisanity validation as MCP tools that AI agents (Claude, Copilot, etc.)
can call automatically during conversations. Runs over stdio using JSON-RPC 2.0.

Zero external dependencies — stdlib only. Imports MemoryGuardian from guardian.py.

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

# Import the guardian from the same directory
sys.path.insert(0, str(Path(__file__).parent))
from guardian import (
    MemoryGuardian,
    format_verdict,
    MEMORY_FILE,
    OLLAMA_URL,
    OLLAMA_MODEL,
    GITHUB_MODEL,
)


# ── MCP Protocol Constants ──────────────────────────────────────────────────

MCP_PROTOCOL_VERSION = "2024-11-05"

SERVER_INFO = {
    "name": "aisanity",
    "version": "0.1.0",
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
    """Handle aisanity_validate tool call."""
    suggestion = args.get("suggestion", "")
    if not suggestion.strip():
        return _tool_result("Error: empty suggestion provided", is_error=True)

    verdict = guardian.validate(suggestion)
    text = format_verdict(verdict)

    # Also include structured data for the AI to parse
    verdict_data = asdict(verdict)
    verdict_data["violations"] = [asdict(v) for v in verdict.violations]
    text += f"\n\n<verdict_json>\n{json.dumps(verdict_data, indent=2)}\n</verdict_json>"

    return _tool_result(text)


def handle_fix(guardian: MemoryGuardian, args: dict) -> dict:
    """Handle aisanity_fix tool call."""
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
    """Handle aisanity_memory tool call."""
    memory = guardian.show_memory()
    return _tool_result(memory)


TOOL_HANDLERS = {
    "aisanity_validate": handle_validate,
    "aisanity_fix": handle_fix,
    "aisanity_memory": handle_memory,
}


# ── MCP Message Router ──────────────────────────────────────────────────────

def handle_message(msg: dict, guardian: MemoryGuardian) -> None:
    """Route an incoming JSON-RPC message to the appropriate handler."""
    method = msg.get("method")
    request_id = msg.get("id")
    params = msg.get("params", {})

    # ── Initialize
    if method == "initialize":
        _log("Client connected — initializing")
        _respond(request_id, {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": SERVER_CAPABILITIES,
            "serverInfo": SERVER_INFO,
        })
        return

    # ── Notifications (no response needed)
    if method == "notifications/initialized":
        _log("Client initialized — ready")
        return
    if method == "notifications/cancelled":
        _log(f"Request cancelled: {params.get('requestId')}")
        return

    # ── List tools
    if method == "tools/list":
        _respond(request_id, {"tools": TOOLS})
        return

    # ── Call tool
    if method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})

        handler = TOOL_HANDLERS.get(tool_name)
        if not handler:
            _respond_error(request_id, -32602, f"Unknown tool: {tool_name}")
            return

        _log(f"Tool call: {tool_name}")
        try:
            result = handler(guardian, tool_args)
            _respond(request_id, result)
        except (urllib.error.URLError, OSError, json.JSONDecodeError,
                RuntimeError, ValueError, KeyError) as exc:
            _log(f"Tool error: {exc}")
            _respond(request_id, _tool_result(f"Error: {exc}", is_error=True))
        return

    # ── Ping
    if method == "ping":
        _respond(request_id, {})
        return

    # ── Unknown method
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

    _log(f"Server started — memory: {args.memory}, ollama: {args.ollama_url}/{args.ollama_model}")

    # Read JSON-RPC messages from stdin, one per line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            handle_message(msg, guardian)
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
