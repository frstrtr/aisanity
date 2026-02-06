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
code --install-extension vscode-extension/aisanity-0.5.0.vsix
```

After installing:

### Option A: Use as a model (simplest — all requests validated)

1. Open the Chat view (Ctrl+Shift+I)
2. Click the **model picker dropdown** at the top of the chat
3. Click **Manage Models** (gear icon)
4. Find **aisanity — AI Memory Guardian** in the provider list
5. Click **+** to add a new configuration
6. Enter your Ollama URL: `http://192.168.86.45:11434`
7. Enter your Ollama model: `devstral:24b`
8. Click OK — the model now appears in your model picker
9. **Select it** as your active model
10. Start chatting — every response is generated via Ollama and validated!

### Option B: Use as a chat participant (per-conversation)

Type `@aisanity` before your question in chat:

```
@aisanity how do I install flask in this project?
```

This routes the question through Copilot's model but validates the response
against your project memory before showing it.

### Option C: MCP tools (voluntary, model-initiated)

The MCP server is auto-registered. Add these custom instructions
(Settings → Copilot → Chat → Instructions):

> Before finalizing any response containing code or commands, call
> `aisanity_validate` to check it against project memory. If violations
> are found, use `aisanity_fix` and revise before presenting.

---

## Configuring Behavior

Open VS Code Settings (Ctrl+,) and search for `aisanity`:

### Connection Settings

| Setting | Default | What it does |
|---------|---------|-------------|
| `aisanity.ollamaUrl` | `http://192.168.86.45:11434` | Your Ollama server address |
| `aisanity.ollamaModel` | `devstral:24b` | Which Ollama model to use |
| `aisanity.githubModel` | `openai/gpt-4o-mini` | Fallback model when Ollama is down |
| `aisanity.memoryFile` | `.ai-memory.md` | Memory file name |

### Behavior Settings

| Setting | Default | What it does |
|---------|---------|-------------|
| `aisanity.enableValidation` | `true` | Master switch for validation |
| `aisanity.enableAutoCorrection` | `true` | Auto-fix violations (disagreement flow) |
| `aisanity.maxCorrectionRetries` | `1` | How many fix attempts (0 = report only, max 3) |
| `aisanity.showValidationBadges` | `true` | Show ✅/⚠️ in responses |
| `aisanity.validationBackend` | `ollama` | `ollama`, `github`, or `auto` (try Ollama first) |

### Example: Report-only mode (no auto-correction)

```json
{
    "aisanity.enableAutoCorrection": false
}
```

Violations are reported but the original response is shown unchanged.

### Example: Maximum strictness

```json
{
    "aisanity.maxCorrectionRetries": 3,
    "aisanity.enableAutoCorrection": true
}
```

Up to 3 correction attempts until the response passes validation.

### Example: Disable validation entirely (pure Ollama proxy)

```json
{
    "aisanity.enableValidation": false
}
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

## Ollama Server Setup

### Check connectivity

```bash
curl -s http://192.168.86.45:11434/api/version
```

### Pull the recommended model

```bash
ollama pull devstral:24b
```

### Available models

| Model | Size | Best for |
|-------|------|----------|
| `devstral:24b` | 14.3 GB | **Default** — code-focused, fast |
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

# Override model
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

## Uninstall

### VS Code Extension
```bash
code --uninstall-extension frstrtr.aisanity
```

### CLI
```bash
sudo rm /usr/local/bin/aisanity
```
