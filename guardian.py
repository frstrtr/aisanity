#!/usr/bin/env python3
"""
aisanity — AI Memory Guardian

Pure-LLM validator that checks AI suggestions against a plain-text project
memory file (.ai-memory.md). Uses a local Ollama server as the primary
backend and falls back to GitHub Models API (free via Copilot subscription)
when Ollama is unreachable.

Zero external dependencies — stdlib only.
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Optional


# ── Defaults ────────────────────────────────────────────────────────────────

OLLAMA_URL = "http://192.168.86.45:11434"
OLLAMA_MODEL = "devstral:24b"
GITHUB_MODELS_URL = "https://models.github.ai/inference"
GITHUB_MODEL = "openai/gpt-4o-mini"
MEMORY_FILE = ".ai-memory.md"
HTTP_TIMEOUT = 120  # seconds — generous for cold model loads on Ollama


# ── Data structures ─────────────────────────────────────────────────────────

@dataclass
class Violation:
    rule: str
    found: str
    expected: str
    explanation: str


@dataclass
class Verdict:
    is_valid: bool
    violations: List[Violation] = field(default_factory=list)
    backend: str = ""
    model: str = ""
    error: str = ""


VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "is_valid": {"type": "boolean"},
        "violations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "rule":        {"type": "string"},
                    "found":       {"type": "string"},
                    "expected":    {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": ["rule", "found", "expected", "explanation"],
            },
        },
    },
    "required": ["is_valid", "violations"],
}


# ── LLM Backends ────────────────────────────────────────────────────────────

class OllamaBackend:
    """Local Ollama server — primary backend."""

    def __init__(self, base_url: str = OLLAMA_URL, model: str = OLLAMA_MODEL):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.name = "ollama"

    def is_available(self) -> bool:
        """Quick health check — can we reach the server?"""
        try:
            req = urllib.request.Request(f"{self.base_url}/api/version")
            with urllib.request.urlopen(req, timeout=3):
                return True
        except (urllib.error.URLError, OSError):
            return False

    def chat(self, system: str, user: str) -> str:
        """Send a chat request and return the assistant's response text."""
        payload = json.dumps({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            "stream": False,
            "format": VERDICT_SCHEMA,
            "options": {"temperature": 0.1},
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.base_url}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        return result["message"]["content"]


class GitHubModelsBackend:
    """GitHub Models API — free fallback via Copilot subscription."""

    def __init__(self, model: str = GITHUB_MODEL, token: Optional[str] = None):
        self.model = model
        self.token = token or os.environ.get("GITHUB_TOKEN", "")
        self.base_url = GITHUB_MODELS_URL
        self.name = "github-models"

    def is_available(self) -> bool:
        """Check that we have a token configured."""
        return bool(self.token)

    def chat(self, system: str, user: str) -> str:
        """Send a chat request to GitHub Models API."""
        if not self.token:
            raise RuntimeError("GITHUB_TOKEN environment variable is not set")

        payload = json.dumps({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        return result["choices"][0]["message"]["content"]


# ── Guardian ─────────────────────────────────────────────────────────────────

SYSTEM_PROMPT_TEMPLATE = """\
You are a Project Memory Guardian. Your job is to check whether an AI-generated
suggestion (a command, code snippet, or piece of advice) complies with the
project's documented requirements.

Here is the project memory — this is the ABSOLUTE SOURCE OF TRUTH:

---
{memory}
---

INSTRUCTIONS:
1. Read the suggestion carefully.
2. Compare it against EVERY rule, requirement, and forbidden pattern in the
   project memory above.
3. Identify ALL violations — even subtle or implied ones.
4. Return your verdict as JSON with this exact schema:
   {{"is_valid": true/false, "violations": [...]}}
   Each violation must have: "rule", "found", "expected", "explanation".
5. If the suggestion fully complies, return:
   {{"is_valid": true, "violations": []}}
6. Be strict. When in doubt, flag it.
7. Return ONLY the JSON object — no markdown, no commentary."""


CORRECTION_PROMPT_TEMPLATE = """\
You are a Project Memory Guardian. An AI assistant produced a response that
violates the project's documented requirements.

Here is the project memory — the ABSOLUTE SOURCE OF TRUTH:

---
{memory}
---

Here is the ORIGINAL AI RESPONSE that has violations:

---
{original}
---

Here are the VIOLATIONS found:

{violations}

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
5. Return ONLY the correction text — no JSON, no markdown fences."""


class MemoryGuardian:
    """
    Loads a plain-text .ai-memory.md file and validates AI suggestions
    against it using a local Ollama LLM (primary) or GitHub Models (fallback).
    """

    def __init__(
        self,
        memory_file: str = MEMORY_FILE,
        ollama_url: str = OLLAMA_URL,
        ollama_model: str = OLLAMA_MODEL,
        github_model: str = GITHUB_MODEL,
        github_token: Optional[str] = None,
    ):
        self.memory_path = Path(memory_file)
        self.memory_text = self._load_memory()
        self.backends = [
            OllamaBackend(base_url=ollama_url, model=ollama_model),
            GitHubModelsBackend(model=github_model, token=github_token),
        ]

    def _load_memory(self) -> str:
        """Load the plain-text memory file."""
        if not self.memory_path.exists():
            return ""
        return self.memory_path.read_text(encoding="utf-8")

    def _build_system_prompt(self) -> str:
        """Inject the memory into the system prompt template."""
        return SYSTEM_PROMPT_TEMPLATE.format(memory=self.memory_text)

    def _parse_verdict(self, raw: str, backend_name: str, model: str) -> Verdict:
        """Parse the LLM's JSON response into a Verdict."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # Try to extract JSON from markdown code fences
            match = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
            if match:
                data = json.loads(match.group(1))
            else:
                return Verdict(
                    is_valid=False,
                    backend=backend_name,
                    model=model,
                    error=f"Failed to parse LLM response as JSON: {raw[:200]}",
                )

        violations = [
            Violation(
                rule=v.get("rule", "unknown"),
                found=v.get("found", ""),
                expected=v.get("expected", ""),
                explanation=v.get("explanation", ""),
            )
            for v in data.get("violations", [])
        ]
        return Verdict(
            is_valid=data.get("is_valid", len(violations) == 0),
            violations=violations,
            backend=backend_name,
            model=model,
        )

    def validate(self, suggestion: str) -> Verdict:
        """
        Validate an AI suggestion against project memory.

        Tries Ollama first; on failure, falls back to GitHub Models.
        """
        if not self.memory_text:
            return Verdict(
                is_valid=True,
                error="No memory file loaded — nothing to validate against",
            )

        system = self._build_system_prompt()
        user = f"Check this AI suggestion for compliance:\n\n{suggestion}"

        last_error = ""
        for backend in self.backends:
            if not backend.is_available():
                last_error = f"{backend.name}: not available"
                _log(f"⏭  {backend.name} not available, trying next…")
                continue
            try:
                _log(f"🔍 Validating via {backend.name} ({backend.model})…")
                raw = backend.chat(system, user)
                return self._parse_verdict(raw, backend.name, backend.model)
            except Exception as exc:
                last_error = f"{backend.name}: {exc}"
                _log(f"⚠️  {backend.name} failed: {exc}")
                continue

        return Verdict(
            is_valid=False,
            error=f"All backends failed. Last error: {last_error}",
        )

    def _chat_freeform(self, system: str, user: str) -> Optional[str]:
        """Send a freeform (non-structured) chat to the first available backend."""
        last_error = ""
        for backend in self.backends:
            if not backend.is_available():
                continue
            try:
                _log(f"📝 Generating correction via {backend.name} ({backend.model})…")
                # For Ollama we need to skip the format schema for freeform text
                if isinstance(backend, OllamaBackend):
                    return self._ollama_freeform(backend, system, user)
                else:
                    return backend.chat(system, user)
            except Exception as exc:
                last_error = f"{backend.name}: {exc}"
                _log(f"⚠️  {backend.name} failed: {exc}")
                continue
        _log(f"⚠️  Could not generate correction: {last_error}")
        return None

    def _ollama_freeform(self, backend: OllamaBackend, system: str, user: str) -> str:
        """Ollama chat without structured output format (returns plain text)."""
        payload = json.dumps({
            "model": backend.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            "stream": False,
            "options": {"temperature": 0.3},
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{backend.base_url}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        return result["message"]["content"]

    def generate_correction(self, original: str, verdict: Verdict) -> Optional[str]:
        """
        Generate a correction prompt from violations that can be pasted back
        into the AI chat to instruct it to fix its response.
        """
        if verdict.is_valid or not verdict.violations:
            return None

        violations_text = "\n".join(
            f"{i}. [{v.rule}] Found: `{v.found}` → Expected: `{v.expected}` — {v.explanation}"
            for i, v in enumerate(verdict.violations, 1)
        )

        system = CORRECTION_PROMPT_TEMPLATE.format(
            memory=self.memory_text,
            original=original,
            violations=violations_text,
        )
        user = "Generate the correction prompt now."

        return self._chat_freeform(system, user)

    def show_memory(self) -> str:
        """Return the raw memory file contents for display."""
        if not self.memory_text:
            return "No memory file loaded."
        return self.memory_text


# ── Output formatting ────────────────────────────────────────────────────────

def _log(msg: str) -> None:
    """Print a log message to stderr."""
    print(msg, file=sys.stderr)


def format_verdict(verdict: Verdict) -> str:
    """Format a Verdict into a human-readable report."""
    lines = []

    if verdict.error:
        lines.append(f"⚠️  ERROR: {verdict.error}")
        return "\n".join(lines)

    if verdict.is_valid:
        lines.append("✅ PASSED — suggestion complies with project memory")
    else:
        lines.append("❌ FAILED — violations detected!\n")
        for i, v in enumerate(verdict.violations, 1):
            lines.append(f"  Violation {i}:")
            lines.append(f"    Rule:        {v.rule}")
            lines.append(f"    Found:       {v.found}")
            lines.append(f"    Expected:    {v.expected}")
            lines.append(f"    Explanation: {v.explanation}")
            lines.append("")

    lines.append(f"  [backend: {verdict.backend} | model: {verdict.model}]")
    return "\n".join(lines)


def format_correction(correction: str) -> str:
    """Format a correction prompt for display."""
    border = "━" * 55
    return (
        f"\n📝 CORRECTION PROMPT (paste this back to the AI):\n"
        f"{border}\n"
        f"{correction}\n"
        f"{border}"
    )


# ── Project Init ─────────────────────────────────────────────────────────────

AISANITY_DIR = Path(__file__).resolve().parent

MEMORY_TEMPLATE = """\
# PROJECT MEMORY — {project_name}

## Identity
- Project: {project_name}
- Purpose: (describe what this project does)

## Environment
- Language: (e.g., Python 3.11, TypeScript 5, Go 1.22)
- Package manager: (e.g., pip, uv, pnpm, cargo)
- Framework: (e.g., FastAPI, Next.js, none)
- Runtime: (e.g., CPython, Node.js 20, PyPy)

## Critical Requirements
### (Category — e.g., Package Manager)
- REQUIRED: (what must be used)
- FORBIDDEN: (what must NOT be used)
- Reason: (why)

## Forbidden Patterns
- (list things the AI should never suggest)

## Common Mistakes
| Wrong | Correct | Why |
|-------|---------|-----|
| `(wrong command)` | `(correct command)` | (reason) |
"""


def _init_project(target_dir: str = ".") -> None:
    """Initialize aisanity in a project: create .ai-memory.md and .vscode/mcp.json."""
    target = Path(target_dir).resolve()
    project_name = target.name

    # ── .ai-memory.md
    memory_path = target / MEMORY_FILE
    if memory_path.exists():
        print(f"⏭  {MEMORY_FILE} already exists — skipping")
    else:
        memory_path.write_text(
            MEMORY_TEMPLATE.format(project_name=project_name),
            encoding="utf-8",
        )
        print(f"✅ Created {memory_path}")

    # ── .vscode/mcp.json
    vscode_dir = target / ".vscode"
    mcp_path = vscode_dir / "mcp.json"

    mcp_config = {
        "servers": {
            "aisanity": {
                "type": "stdio",
                "command": "python3",
                "args": [str(AISANITY_DIR / "mcp_server.py")],
                "env": {
                    "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
                }
            }
        }
    }

    if mcp_path.exists():
        # Merge — don't overwrite existing MCP servers
        try:
            existing = json.loads(mcp_path.read_text(encoding="utf-8"))
            servers = existing.get("servers", {})
            if "aisanity" in servers:
                print(f"⏭  aisanity already in {mcp_path} — skipping")
            else:
                servers["aisanity"] = mcp_config["servers"]["aisanity"]
                existing["servers"] = servers
                mcp_path.write_text(
                    json.dumps(existing, indent=2) + "\n",
                    encoding="utf-8",
                )
                print(f"✅ Added aisanity to {mcp_path}")
        except (json.JSONDecodeError, KeyError):
            print(f"⚠️  {mcp_path} exists but could not be parsed — skipping")
    else:
        vscode_dir.mkdir(parents=True, exist_ok=True)
        mcp_path.write_text(
            json.dumps(mcp_config, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"✅ Created {mcp_path}")

    print(f"\n🎉 aisanity initialized in {target}")
    print(f"   1. Edit {MEMORY_FILE} with your project's rules")
    print(f"   2. Reload VS Code window (Ctrl+Shift+P → 'Reload Window')")
    print(f"   3. Claude/Copilot will now auto-validate via MCP")


def _install_global() -> None:
    """Install aisanity MCP server into VS Code dedicated user MCP config."""
    home = Path.home()
    # VS Code uses a dedicated mcp.json (not settings.json) since late 2025
    candidates = [
        home / ".config" / "Code" / "User" / "mcp.json",
        home / ".config" / "Code - Insiders" / "User" / "mcp.json",
        home / "Library" / "Application Support" / "Code" / "User" / "mcp.json",
        home / "AppData" / "Roaming" / "Code" / "User" / "mcp.json",
    ]

    mcp_path = None
    for p in candidates:
        if p.exists():
            mcp_path = p
            break
        # Also check if the parent (User dir) exists — we can create mcp.json there
        if p.parent.exists():
            mcp_path = p
            break

    if not mcp_path:
        print("⚠️  Could not find VS Code user config directory")
        print("   Create this file manually at ~/.config/Code/User/mcp.json:\n")
        _print_global_config()
        return

    mcp_server_entry = {
        "type": "stdio",
        "command": "python3",
        "args": [str(AISANITY_DIR / "mcp_server.py")],
        "env": {
            "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
        }
    }

    if mcp_path.exists():
        try:
            existing = json.loads(mcp_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"⚠️  {mcp_path} could not be parsed")
            print(f"   Add this manually:\n")
            _print_global_config()
            return

        servers = existing.get("servers", {})
        if "aisanity" in servers:
            print("⏭  aisanity already in global MCP config — skipping")
            return

        servers["aisanity"] = mcp_server_entry
        existing["servers"] = servers
        mcp_path.write_text(
            json.dumps(existing, indent=2) + "\n",
            encoding="utf-8",
        )
    else:
        mcp_config = {
            "servers": {
                "aisanity": mcp_server_entry
            }
        }
        mcp_path.write_text(
            json.dumps(mcp_config, indent=2) + "\n",
            encoding="utf-8",
        )

    print(f"✅ Added aisanity to {mcp_path}")
    print(f"   Reload VS Code window (Ctrl+Shift+P → 'Reload Window')")
    print(f"   aisanity MCP is now available in ALL projects")


def _print_global_config() -> None:
    """Print the global config snippet for manual installation."""
    config = {
        "servers": {
            "aisanity": {
                "type": "stdio",
                "command": "python3",
                "args": [str(AISANITY_DIR / "mcp_server.py")],
                "env": {
                    "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
                }
            }
        }
    }
    print(json.dumps(config, indent=2))


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        prog="aisanity",
        description="AI Memory Guardian — validate AI suggestions against project memory",
    )
    subparsers = parser.add_subparsers(dest="command")

    # ── init subcommand
    init_parser = subparsers.add_parser(
        "init",
        help="Initialize aisanity in a project (creates .ai-memory.md + .vscode/mcp.json)",
    )
    init_parser.add_argument(
        "target",
        nargs="?",
        default=".",
        help="Project directory (default: current directory)",
    )

    # ── install-global subcommand
    subparsers.add_parser(
        "install-global",
        help="Add aisanity MCP server to VS Code global user settings (all projects)",
    )

    # ── validate (default behavior)
    parser.add_argument(
        "suggestion",
        nargs="*",
        help="The AI suggestion to validate (command, code, advice)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Read suggestion from stdin (for piping multi-line input)",
    )
    parser.add_argument(
        "--memory",
        default=MEMORY_FILE,
        help=f"Path to memory file (default: {MEMORY_FILE})",
    )
    parser.add_argument(
        "--show-memory",
        action="store_true",
        help="Print the loaded memory file and exit",
    )
    parser.add_argument(
        "--ollama-url",
        default=OLLAMA_URL,
        help=f"Ollama server URL (default: {OLLAMA_URL})",
    )
    parser.add_argument(
        "--ollama-model",
        default=OLLAMA_MODEL,
        help=f"Ollama model to use (default: {OLLAMA_MODEL})",
    )
    parser.add_argument(
        "--github-model",
        default=GITHUB_MODEL,
        help=f"GitHub Models fallback model (default: {GITHUB_MODEL})",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Generate a correction prompt to paste back to the AI when violations are found",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Output raw JSON verdict instead of formatted text",
    )

    args = parser.parse_args()

    # -- Subcommands
    if args.command == "init":
        _init_project(args.target)
        return

    if args.command == "install-global":
        _install_global()
        return

    github_token = os.environ.get("GITHUB_TOKEN")

    guardian = MemoryGuardian(
        memory_file=args.memory,
        ollama_url=args.ollama_url,
        ollama_model=args.ollama_model,
        github_model=args.github_model,
        github_token=github_token,
    )

    # -- Show memory
    if args.show_memory:
        print(guardian.show_memory())
        return

    # -- Read suggestion
    if args.check:
        suggestion = sys.stdin.read()
    elif args.suggestion:
        suggestion = " ".join(args.suggestion)
    else:
        parser.print_help()
        sys.exit(1)

    if not suggestion.strip():
        print("Error: empty suggestion", file=sys.stderr)
        sys.exit(1)

    # -- Validate
    verdict = guardian.validate(suggestion)

    # -- Output
    if args.json_output:
        out = asdict(verdict)
        out["violations"] = [asdict(v) for v in verdict.violations]
        if args.fix and not verdict.is_valid:
            correction = guardian.generate_correction(suggestion, verdict)
            out["correction"] = correction or ""
        print(json.dumps(out, indent=2))
    else:
        print(format_verdict(verdict))
        # Generate correction prompt if --fix and violations found
        if args.fix and not verdict.is_valid:
            correction = guardian.generate_correction(suggestion, verdict)
            if correction:
                print(format_correction(correction))

    sys.exit(0 if verdict.is_valid else 1)


if __name__ == "__main__":
    main()
