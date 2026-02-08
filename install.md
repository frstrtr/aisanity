# aisanity — Installation & Setup

## Prerequisites

- Ollama server accessible on the LAN (default: `192.168.86.45:11434`)
- VS Code 1.99+ (for extension features)
- (Optional) Python 3.7+ for CLI usage
- (Optional) GitHub account for fallback model access

---

## Quick Install: VS Code Extension (recommended)

```bash
cd ~/Github/aisanity
code --install-extension vscode-extension/aisanity-0.6.3.vsix
```

After installing, verify your setup:

```
Ctrl+Shift+P → aisanity: Health Check
```

This checks memory file, Ollama connectivity, model availability, and sends
test requests to both models.

---

## Setup: Model Picker (recommended)

### Option A: Cloud model generates, Ollama validates (default)

1. Open the Chat view (Ctrl+Shift+I)
2. Click the **model picker dropdown** at the top of the chat
3. Click **Manage Models** (gear icon)
4. Find **aisanity — AI Memory Guardian** in the provider list
5. Click **+** to add a new configuration
6. Enter your Ollama URL: `http://192.168.86.45:11434`
7. Enter your Ollama model: `devstral:24b`
8. Click OK — the model now appears in your model picker
9. **Select it** as your active model
10. Start chatting — Claude Opus 4.6 generates, Ollama validates!

The default `aisanity.mainModel` is `copilot:claude-opus-4.6`. Change it in
settings to use a different model:

```json
// Use GPT-5.1 for generation instead
{ "aisanity.mainModel": "copilot:gpt-5.1" }
```

### Option B: Ollama handles everything (no cloud)

```json
{ "aisanity.mainModel": "ollama" }
```

Then configure via Model Picker as above. Ollama does both generation and validation.

### Option C: Use as a chat participant (per-conversation)

Type `@aisanity` before your question in chat:

```
@aisanity how do I install flask in this project?
```

This routes the question through Copilot's model but validates the response
against your project memory before showing it.

### Option D: MCP tools (voluntary, model-initiated)

The MCP server is auto-registered. Add these custom instructions
(Settings → Copilot → Chat → Instructions):

> Before finalizing any response containing code or commands, call
> `aisanity_validate` to check it against project memory. If violations
> are found, use `aisanity_fix` and revise before presenting.

---

## Configuring Behavior

Open VS Code Settings (Ctrl+,) and search for `aisanity`:

### Main Model (generation)

| Setting | Default | What it does |
|---------|---------|-------------|
| `aisanity.mainModel` | `copilot:claude-opus-4.6` | Which model generates responses |

**Examples:**
```json
// Use Copilot Claude Opus 4.6 (default)
{ "aisanity.mainModel": "copilot:claude-opus-4.6" }

// Use GPT-5.1
{ "aisanity.mainModel": "copilot:gpt-5.1" }

// Use Ollama directly (no cloud model)
{ "aisanity.mainModel": "ollama" }
```

### Checker Model (validation)

| Setting | Default | What it does |
|---------|---------|-------------|
| `aisanity.ollamaUrl` | `http://192.168.86.45:11434` | Ollama server address |
| `aisanity.ollamaModel` | `devstral:24b` | Ollama checker model |
| `aisanity.githubModel` | `openai/gpt-4o-mini` | Fallback when Ollama is down |
| `aisanity.memoryFile` | `.ai-memory.md` | Memory file name |

### Behavior

| Setting | Default | What it does |
|---------|---------|-------------|
| `aisanity.enableValidation` | `true` | Master switch for validation |
| `aisanity.enableAutoCorrection` | `true` | Auto-fix violations (disagreement flow) |
| `aisanity.maxCorrectionRetries` | `1` | How many fix attempts (0 = report only, max 3) |
| `aisanity.showValidationBadges` | `true` | Show ✅/⚠️ in responses |
| `aisanity.validationBackend` | `ollama` | `ollama`, `github`, or `auto` |

### Configuration Examples

**Report-only mode** (no auto-correction):
```json
{ "aisanity.enableAutoCorrection": false }
```
Violations are reported but the original response is shown unchanged.

**Maximum strictness** (3 correction attempts):
```json
{
    "aisanity.maxCorrectionRetries": 3,
    "aisanity.enableAutoCorrection": true
}
```
Up to 3 correction attempts until the response passes validation.

**Disable validation entirely** (pure proxy):
```json
{ "aisanity.enableValidation": false }
```

**Use a different checker model:**
```json
{ "aisanity.ollamaModel": "qwen2.5:32b" }
```

---

## Creating a Project Memory File

Run **aisanity: Init Project** from the Command Palette, or create `.ai-memory.md` manually:

```markdown
# PROJECT MEMORY — my-project

## Identity
- Project: my-project
- Purpose: Brief description

## Environment
- Language: Python 3.11
- Package manager: uv
- Framework: FastAPI

## Critical Requirements
### Package Manager
- REQUIRED: uv
- FORBIDDEN: pip, pip3, conda
- Reason: Project uses uv for fast dependency management

### Code Style
- REQUIRED: Type hints on all function signatures
- FORBIDDEN: Any use of `print()` for logging — use `logging` module

## Forbidden Patterns
- Never use `requests` library — use `httpx`
- Never use `os.path` — use `pathlib.Path`
- Never hardcode secrets — use environment variables

## Common Mistakes
| Wrong | Correct | Why |
|-------|---------|-----|
| `pip install X` | `uv add X` | Project uses uv |
| `import requests` | `import httpx` | Async-first HTTP |
```

The memory file is **plain Markdown** — write your rules however you want.
The LLM reads it as-is and checks every AI response against it.

---

## Health Check

Run **aisanity: Health Check** from the Command Palette to verify your setup.
It tests:

- ✅/❌ Memory file — found, path, size
- ✅/❌ Main model — resolution from VS Code model API
- 🧪 Main model test request — sends a ping, measures response time
- ✅/❌ Ollama server — connectivity, version
- ✅/❌ Ollama checker model — availability via `/api/show`
- 🧪 Ollama test request — sends a ping, measures response time
- Settings summary table
- Overall verdict

**Example output:**
```
✅ Memory file: /home/user/project/.ai-memory.md (8.4 KB)
✅ Main model: Claude Opus 4.6 (copilot/claude-opus-4.6)
🧪 Test: ✅ responded in 1.2s
✅ Ollama: reachable (v0.9.0), devstral:24b available
🧪 Test: ✅ responded in 0.8s
✅ All systems operational
```

---

## Ollama Server Setup

### Check connectivity

```bash
curl -s http://192.168.86.45:11434/api/version
```

### Pull the recommended checker model

```bash
ollama pull devstral:24b
```

### Available models

| Model | Size | Best for |
|-------|------|----------|
| `devstral:24b` | 14.3 GB | **Default checker** — code-focused, fast |
| `gemma3:27b` | 17.4 GB | General reasoning |
| `qwen2.5:32b` | 19.9 GB | Strong multilingual |
| `qwq:latest` | 19.9 GB | Deep thinking |
| `llama3.3:70b` | 42.5 GB | High accuracy, slower |
| `deepseek-r1:671b` | 404 GB | Maximum capability |

---

## GitHub Token (fallback — optional)

If the Ollama server goes down, aisanity falls back to free models via GitHub.

1. Go to https://github.com/settings/tokens
2. Create a **Personal Access Token** with **`models:read`** scope
3. Add to your shell profile:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

---

## Manual Install (CLI)

### Clone the repository

```bash
cd ~/Github
git clone https://github.com/frstrtr/aisanity.git
cd aisanity
```

### Make it system-wide

```bash
chmod +x ~/Github/aisanity/guardian.py
sudo ln -sf ~/Github/aisanity/guardian.py /usr/local/bin/aisanity
```

### CLI usage

```bash
# Validate a command
aisanity "pip install flask"

# Validate piped input
echo "import requests" | aisanity --check

# Validate with correction prompt
echo "import requests" | aisanity --check --fix

# JSON output
aisanity --json "pip install flask"

# Override checker model
aisanity --ollama-model qwen2.5:32b "pip install flask"
```

---

## MCP Server (manual setup)

### Global install (all projects)

```bash
python3 guardian.py install-global
```

### Per-project install

```bash
cd ~/Github/my-project
python3 ~/Github/aisanity/guardian.py init
```

### Manual MCP config

Create `~/.config/Code/User/mcp.json`:

```json
{
  "servers": {
    "aisanity": {
      "type": "stdio",
      "command": "python3",
      "args": ["/home/user0/Github/aisanity/mcp_server.py"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    }
  }
}
```

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `aisanity: Init Project` | Create `.ai-memory.md` template in workspace |
| `aisanity: Show Memory` | Open the project memory file |
| `aisanity: Validate Selection` | Validate selected text against project memory |
| `aisanity: Health Check` | Test all components — memory, models, connectivity |

---

## Uninstall

### VS Code Extension
```bash
code --uninstall-extension frstrtr.aisanity
```

### CLI
```bash
sudo rm /usr/local/bin/aisanity
```
