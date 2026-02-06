# aisanity — AI Memory Guardian

A lightweight tool that validates AI suggestions against a **plain-text project
memory file** (`.ai-memory.md`). It catches context drift, hallucinations, and
forgotten constraints by asking a local LLM to compare every suggestion against
the documented source of truth.

**Zero external dependencies** — pure TypeScript/Node.js for the VS Code
extension, Python stdlib for the CLI.

## Problem

Advanced models (Claude, GPT, etc.) exhibit context drift during long sessions:
- Forget project-specific tooling (e.g., using `pip` when the project requires `uv`)
- Hallucinate packages, commands, or architecture patterns
- Revert to defaults that violate project constraints

## Solution

A lightweight guardian that:
1. Reads a **plain-text Markdown memory file** (`.ai-memory.md`) — human-readable and editable
2. Sends the memory + the AI suggestion to a **local Ollama LLM** on the LAN
3. The LLM compares the suggestion against every documented rule
4. Returns a structured verdict (pass/fail + specific violations)
5. **Auto-corrects** the response if violations are found (configurable)
6. Falls back to **GitHub Models API** (free via Copilot subscription) when Ollama is unreachable

## Architecture

```
┌─────────────────┐     ┌───────────────────┐     ┌──────────────┐
│  AI Suggestion  │────▶│  aisanity         │────▶│  Verdict     │
│  (text, code,   │     │                   │     │  (pass/fail  │
│   command)      │     │  1. Load memory   │     │  + violations│
└─────────────────┘     │  2. Build prompt  │     │  + correction│
                        │  3. Call LLM      │     └──────────────┘
                        │  4. Parse verdict │
                        │  5. Auto-correct  │
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

## Three Integration Layers

aisanity provides three ways to integrate, from simplest to most flexible:

### 1. Model Picker (v0.5) — simplest

Select **aisanity** from the VS Code model dropdown. ALL chat requests from ANY
participant (Copilot, workspace, etc.) get proxied through validation.

```
VS Code Model Picker → Manage Models → Add aisanity
→ Configure Ollama URL + Model → Done
```

**How it works:**
- Aisanity appears as a selectable model in the chat model picker
- Every response is generated via Ollama, validated against `.ai-memory.md`
- Violations are auto-corrected before you see the response
- No `@aisanity` prefix needed — just pick the model and forget about it

### 2. @aisanity Chat Participant (v0.3) — per-conversation

Type `@aisanity` before your question to route it through the guardian:

```
@aisanity how do I install flask in this project?
```

**How it works:**
1. Forwards your question to the selected Copilot model (with project memory injected)
2. Collects the FULL response
3. Validates against `.ai-memory.md` via local Ollama
4. If violations → shows them, auto-corrects, re-validates
5. If clean → streams the original with a ✅ badge

### 3. MCP Tools (v0.1) — voluntary

The AI agent can call `aisanity_validate`, `aisanity_fix`, or `aisanity_memory`
tools during conversations. This is voluntary — the model decides when to validate.

**MCP Tools:**

| Tool | Purpose |
|------|---------|
| `aisanity_validate` | Check a suggestion against `.ai-memory.md` — returns pass/fail + violations |
| `aisanity_fix` | Validate + return correction prompt if violations found |
| `aisanity_memory` | Read the project memory (so the AI can proactively follow rules) |

---

## Installation

### Option 1: VS Code Extension (recommended)

```bash
code --install-extension vscode-extension/aisanity-0.5.0.vsix
```

Then:
1. Run **aisanity: Init Project** from the Command Palette (Ctrl+Shift+P)
2. Edit `.ai-memory.md` with your project rules
3. **To use as a model:** Go to the model picker → Manage Models → click **+** next to aisanity → configure Ollama URL + model → select the model
4. **To use as a participant:** Type `@aisanity` before your question
5. **MCP tools** are auto-registered — no manual config needed

### Option 2: CLI (standalone)

```bash
git clone https://github.com/frstrtr/aisanity.git
cd aisanity
python3 guardian.py "pip install flask"
```

See [install.md](install.md) for detailed CLI/MCP setup.

---

## Settings

All settings are under `aisanity.*` in VS Code settings:

### Connection Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aisanity.ollamaUrl` | `http://192.168.86.45:11434` | Ollama server URL |
| `aisanity.ollamaModel` | `devstral:24b` | Ollama model for generation + validation |
| `aisanity.githubModel` | `openai/gpt-4o-mini` | GitHub Models fallback model |
| `aisanity.memoryFile` | `.ai-memory.md` | Project memory filename |

### Behavior Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aisanity.enableValidation` | `true` | Enable/disable validation of AI responses |
| `aisanity.enableAutoCorrection` | `true` | Auto-correct when violations found (disagreement flow) |
| `aisanity.maxCorrectionRetries` | `1` | Max correction attempts (0 = report only, up to 3) |
| `aisanity.showValidationBadges` | `true` | Show ✅/⚠️ status badges in responses |
| `aisanity.validationBackend` | `ollama` | Which backend: `ollama`, `github`, or `auto` |

### Disagreement Flow

When `enableAutoCorrection` is `true` and violations are found:

```
AI generates response
    ↓
aisanity validates against .ai-memory.md
    ↓
❌ Violations found!
    ↓
aisanity sends violations back to the model
    ↓
Model generates corrected response
    ↓
aisanity re-validates (up to maxCorrectionRetries times)
    ↓
✅ Clean → show to user
⚠️ Still has issues → show with warning
```

Set `enableAutoCorrection: false` or `maxCorrectionRetries: 0` to disable this
and just see the violations report with the original response.

---

## Ollama Server Setup

The extension expects an Ollama server on the LAN. Default: `192.168.86.45:11434`.

```bash
# Verify connectivity
curl http://192.168.86.45:11434/api/version

# Pull the default model
ollama pull devstral:24b
```

### Available Models (on LAN server)

| Model | Size | Notes |
|-------|------|-------|
| `devstral:24b` | 14.3 GB | **Default** — code-focused, fast |
| `gemma3:27b` | 17.4 GB | Strong general reasoning |
| `qwen2.5:32b` | 19.9 GB | Strong reasoning |
| `qwq:latest` | 19.9 GB | Thinking model |
| `llama3.3:70b` | 42.5 GB | High accuracy, slower |
| `deepseek-r1:671b` | 404 GB | Maximum capability |

---

## CLI Usage (fallback)

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

---

## Example Output

```
❌ FAILED — violations detected!

  Violation 1:
    Rule:        Dependencies
    Found:       import requests
    Expected:    import urllib.request
    Explanation: Project requires stdlib only — no external packages

  [backend: ollama | model: devstral:24b]
```

---

## Project Structure

```
aisanity/
├── .ai-memory.md          # aisanity's own project memory
├── guardian.py             # Python CLI tool + library (standalone)
├── mcp_server.py           # Python MCP server (standalone)
├── install.md              # Detailed installation guide
├── README.md               # This file
└── vscode-extension/
    ├── package.json        # Extension manifest
    ├── src/
    │   ├── extension.ts    # VS Code activation + commands
    │   ├── guardian.ts     # Core validation library (TypeScript port)
    │   ├── mcpServer.ts    # MCP server (TypeScript, standalone)
    │   ├── chatParticipant.ts  # @aisanity chat participant
    │   └── modelProvider.ts    # Language model provider (model picker)
    ├── dist/               # Compiled bundles
    ├── esbuild.js          # Build script
    └── *.vsix              # Packaged extension
```

## License

MIT
