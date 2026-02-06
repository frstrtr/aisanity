# aisanity — AI Memory Guardian

A pure-LLM tool that validates AI suggestions against a **plain-text project
memory file** (`.ai-memory.md`). It catches context drift, hallucinations, and
forgotten constraints by asking a local LLM to compare every suggestion against
the documented source of truth.

**Zero external dependencies** — Python stdlib only.

## Problem

Advanced models (Claude, GPT, etc.) eventually exhibit context drift during long
sessions, causing them to:
- Forget project-specific tooling (e.g., using `python3` when the project requires `pypy3`)
- Hallucinate packages, commands, or architecture patterns
- Revert to defaults that violate project constraints

## Solution

A lightweight guardian that:
1. Reads a **plain-text Markdown memory file** (`.ai-memory.md`) — human-readable and editable
2. Sends the memory + the AI suggestion to a **local Ollama LLM** on the LAN
3. The LLM compares the suggestion against every documented rule
4. Returns a structured verdict (pass/fail + specific violations)
5. Falls back to **GitHub Models API** (free via Copilot subscription) when Ollama is unreachable

## Architecture

```
┌─────────────────┐     ┌───────────────────┐     ┌──────────────┐
│  AI Suggestion  │────▶│  guardian.py      │────▶│  Verdict     │
│  (text, code,   │     │                   │     │  (pass/fail  │
│   command)      │     │  1. Load memory   │     │  + violations│
└─────────────────┘     │  2. Build prompt  │     └──────────────┘
                        │  3. Call LLM      │
                        │  4. Parse verdict │
                        └────────┬──────────┘
                                 │
                        ┌────────┴────────┐
                        │ .ai-memory.md   │◀── human-editable
                        │ (plain text)    │    plain-text file
                        └─────────────────┘
                                 │
                  ┌──────────────┼─────────────┐
                  │ PRIMARY      │             │ FALLBACK
           ┌──────┴──────┐             ┌───────┴───────┐
           │  Ollama LLM │             │ GitHub Models │
           │  LAN server │             │ (free tier)   │
           │  :11434     │             │ models.github │
           └─────────────┘             └───────────────┘
```

## MCP Server — Automatic AI Validation (Recommended)

The MCP server lets your AI agent (Claude, Copilot) call aisanity
**automatically** during conversations — no manual copy-paste needed.

### Option A: Global install (all projects)

```bash
python3 guardian.py install-global
```

This adds aisanity to VS Code's dedicated user MCP config (`~/.config/Code/User/mcp.json`).
Every project gets aisanity automatically — you only need a `.ai-memory.md` per project.

### Option B: Per-project install

```bash
cd ~/Github/my-project
python3 /path/to/aisanity/guardian.py init
```

This creates both `.ai-memory.md` (template) and `.vscode/mcp.json` in the project.

### Custom instructions for the AI

Add to Claude's custom instructions (Settings → Copilot → Chat → Instructions):

> Before finalizing any response containing code or commands, call
> `aisanity_validate` to check it against project memory. If violations
> are found, use `aisanity_fix` and revise before presenting.

See [install.md](install.md) for detailed setup.

## Setup (CLI fallback)

### 1. Ollama Server (primary — required)

The tool expects an Ollama server on the LAN at `192.168.86.45:11434`.

```bash
# Verify the server is reachable
curl http://192.168.86.45:11434/api/version
```

Default model: `devstral:24b` (code-focused, fast, accurate for rule validation).

### 2. GitHub Token (fallback — optional)

Set a GitHub PAT with `models:read` scope for the fallback backend:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

### 3. Memory File

Create a `.ai-memory.md` file in your project root. This is plain Markdown —
write your project's requirements, forbidden patterns, and common mistakes as
you would in any document. The LLM reads it as-is.

## Usage

### Validate a command
```bash
python3 guardian.py pip install flask
```

### Validate multi-line input (piped)
```bash
echo "import requests; r = requests.get('http://example.com')" | python3 guardian.py --check
```

### Show loaded memory
```bash
python3 guardian.py --show-memory
```

### JSON output (for scripting)
```bash
python3 guardian.py --json pip install flask
```

### Override model or server
```bash
python3 guardian.py --ollama-model qwen2.5:32b --ollama-url http://10.0.0.5:11434 pip install flask
```

## Available Ollama Models (on LAN server)

| Model | Params | Quant | Size | Notes |
|-------|--------|-------|------|-------|
| `devstral:24b` | 23.6B | Q4_K_M | 14.3 GB | **Default** — code-focused, fast |
| `gemma3:27b` | 27.4B | Q4_K_M | 17.4 GB | Strong general reasoning |
| `qwen2.5:32b` | 32.8B | Q4_K_M | 19.9 GB | Strong reasoning |
| `qwq:latest` | 32.8B | Q4_K_M | 19.9 GB | Thinking model |
| `devstral:24b` | 23.6B | Q4_K_M | 14.3 GB | Code-focused |
| `llama3.3:70b` | 70.6B | Q4_K_M | 42.5 GB | High accuracy, slower |
| `deepseek-r1:671b` | 671B | Q4_K_M | 404 GB | Maximum capability |

## Example Output

```
❌ FAILED — violations detected!

  Violation 1:
    Rule:        Dependencies
    Found:       import requests
    Expected:    import urllib.request
    Explanation: Project requires stdlib only — no external packages

  [backend: ollama | model: gemma3:27b]
```
