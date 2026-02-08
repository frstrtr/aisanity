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
2. Forwards your request to a **main model** (Copilot Claude Opus 4.6, GPT-5.1, or Ollama)
3. Sends the response to an **Ollama checker** on the LAN for validation
4. The checker compares the response against every documented rule
5. Returns a structured verdict (pass/fail + specific violations)
6. **Auto-corrects** the response if violations are found (configurable)
7. Falls back to **GitHub Models API** (free via Copilot subscription) when Ollama is unreachable

## Architecture

```
┌─────────────────┐     ┌───────────────────────────┐     ┌──────────────┐
│  User Question  │────▶│  aisanity                 │────▶│  Validated   │
│                 │     │                           │     │  Response    │
└─────────────────┘     │  1. Inject project memory │     │  ✅ or ⚠️   │
                        │  2. Forward to main model │     └──────────────┘
                        │  3. Validate via Ollama   │
                        │  4. Auto-correct if needed│
                        └────────────┬──────────────┘
                                     │
                        ┌────────────┴────────────┐
                        │  .ai-memory.md          │◀── human-editable
                        │  (plain Markdown rules) │    plain-text file
                        └─────────────────────────┘
                                     │
                   ┌─────────────────┼─────────────────┐
                   │ MAIN MODEL      │                 │ CHECKER
          ┌────────┴────────┐              ┌───────────┴───────┐
          │  VS Code model  │              │  Ollama LLM       │
          │  (Copilot, etc) │              │  devstral:24b      │
          │  or Ollama      │              │  LAN server :11434 │
          └─────────────────┘              └───────────────────┘
```

## Three Integration Layers

aisanity provides three ways to integrate, from simplest to most flexible:

### 1. Model Picker (v0.6) — simplest

Select **aisanity** from the VS Code model dropdown. ALL chat requests from ANY
participant (Copilot, workspace, etc.) get proxied through validation.

```
VS Code Model Picker → Manage Models → Add aisanity
→ Configure Ollama URL + Model → Done
```

**How it works:**
- Aisanity appears as a selectable model in the chat model picker
- Your question goes to the **main model** (default: `copilot:claude-opus-4.6`)
- The response is validated by the **Ollama checker** (default: `devstral:24b`)
- Violations are auto-corrected before you see the response
- Token limits are dynamically queried from the underlying model

**Example — the AI suggests `pip install` but your project uses `uv`:**
```
You: How do I add flask to this project?

aisanity:
---
⚠️ aisanity intercepted violations — auto-correcting…
- Package Manager: found `pip install flask` → expected `uv add flask` — Project uses uv
---

To add flask, run:
  uv add flask

---
✅ Corrected and validated by aisanity (attempt 1) — now complies with project memory
```

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
code --install-extension vscode-extension/aisanity-0.6.2.vsix
```

Then:
1. Run **aisanity: Health Check** from the Command Palette (Ctrl+Shift+P) to verify setup
2. Run **aisanity: Init Project** to create `.ai-memory.md`
3. Edit `.ai-memory.md` with your project rules
4. **To use as a model:** Model picker → Manage Models → **+** aisanity → configure Ollama → select
5. **To use as a participant:** Type `@aisanity` before your question
6. **MCP tools** are auto-registered — no manual config needed

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

### Main Model (generation)

| Setting | Default | Description |
|---------|---------|-------------|
| `aisanity.mainModel` | `copilot:claude-opus-4.6` | Model for response generation |

Choose which model generates responses when aisanity is selected in the picker:

| Value | Generation | Validation |
|-------|-----------|------------|
| `copilot:claude-opus-4.6` (default) | Claude Opus 4.6 | Ollama devstral:24b |
| `copilot:gpt-5.1` | GPT-5.1 | Ollama devstral:24b |
| `copilot:claude-sonnet-4` | Claude Sonnet 4 | Ollama devstral:24b |
| `ollama` | Ollama directly | Ollama (same model) |
| Any `vendor:family` | That VS Code model | Ollama devstral:24b |

**Example — use GPT-5.1 for generation:**
```json
{ "aisanity.mainModel": "copilot:gpt-5.1" }
```

**Example — use Ollama for everything (no cloud):**
```json
{ "aisanity.mainModel": "ollama" }
```

### Checker Model (validation)

| Setting | Default | Description |
|---------|---------|-------------|
| `aisanity.ollamaUrl` | `http://192.168.86.45:11434` | Ollama server URL |
| `aisanity.ollamaModel` | `devstral:24b` | Ollama checker model |
| `aisanity.githubModel` | `openai/gpt-4o-mini` | GitHub Models fallback |
| `aisanity.memoryFile` | `.ai-memory.md` | Project memory filename |

### Behavior

| Setting | Default | Description |
|---------|---------|-------------|
| `aisanity.enableValidation` | `true` | Enable/disable validation |
| `aisanity.enableAutoCorrection` | `true` | Auto-correct violations (disagreement flow) |
| `aisanity.maxCorrectionRetries` | `1` | Correction attempts (0 = report only, max 3) |
| `aisanity.showValidationBadges` | `true` | Show ✅/⚠️ in responses |
| `aisanity.validationBackend` | `ollama` | `ollama`, `github`, or `auto` |

### Configuration Examples

**Report-only mode** (see violations, no auto-fix):
```json
{ "aisanity.enableAutoCorrection": false }
```

**Maximum strictness** (3 correction attempts):
```json
{
    "aisanity.maxCorrectionRetries": 3,
    "aisanity.enableAutoCorrection": true
}
```

**Disable validation entirely** (pure proxy):
```json
{ "aisanity.enableValidation": false }
```

### Disagreement Flow

When `enableAutoCorrection` is `true` and violations are found:

```
Main model generates response
    ↓
Ollama checker validates against .ai-memory.md
    ↓
❌ Violations found!
    ↓
Send violations back to the SAME main model
    ↓
Main model generates corrected response
    ↓
Re-validate (up to maxCorrectionRetries times)
    ↓
✅ Clean → show to user with ✅ badge
⚠️ Still has issues → show with ⚠️ warning
```

Set `enableAutoCorrection: false` or `maxCorrectionRetries: 0` to disable this
and just see the violations report with the original response.

---

## Commands

| Command | Description |
|---------|-------------|
| `aisanity: Init Project` | Create `.ai-memory.md` template in workspace |
| `aisanity: Show Memory` | Open the project memory file |
| `aisanity: Validate Selection` | Validate selected text against project memory |
| `aisanity: Health Check` | Test all components — memory, models, connectivity |

### Health Check

Run **aisanity: Health Check** to verify your setup. It tests:

- ✅/❌ Memory file presence and size
- ✅/❌ Main model resolution (finds the VS Code model by vendor:family)
- 🧪 Main model test request (sends a ping, measures response time)
- ✅/❌ Ollama server connectivity and version
- ✅/❌ Ollama checker model availability
- 🧪 Ollama test request (sends a ping, measures response time)
- Settings summary table

---

## Ollama Server Setup

The extension expects an Ollama server on the LAN. Default: `192.168.86.45:11434`.

```bash
# Verify connectivity
curl http://192.168.86.45:11434/api/version

# Pull the default checker model
ollama pull devstral:24b
```

### Available Models (on LAN server)

| Model | Size | Notes |
|-------|------|-------|
| `devstral:24b` | 14.3 GB | **Default checker** — code-focused, fast |
| `gemma3:27b` | 17.4 GB | Strong general reasoning |
| `qwen2.5:32b` | 19.9 GB | Strong multilingual |
| `qwq:latest` | 19.9 GB | Thinking model |
| `llama3.3:70b` | 42.5 GB | High accuracy, slower |
| `deepseek-r1:671b` | 404 GB | Maximum capability |

---

## CLI Usage (fallback)

### Validate a command
```bash
python3 guardian.py "pip install flask"
```

### Validate piped input
```bash
echo "import requests; r = requests.get('http://example.com')" | python3 guardian.py --check
```

### Show loaded memory
```bash
python3 guardian.py --show-memory
```

### JSON output (for scripting)
```bash
python3 guardian.py --json "pip install flask"
```

### Override model or server
```bash
python3 guardian.py --ollama-model qwen2.5:32b --ollama-url http://10.0.0.5:11434 "pip install flask"
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
    │   ├── extension.ts    # VS Code activation + commands + health check
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
