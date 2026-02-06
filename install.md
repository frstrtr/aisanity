# aisanity — Installation & Setup

## Prerequisites

- Python 3.7+ (stdlib only — zero dependencies)
- Ollama server accessible on the LAN at `192.168.86.45:11434`
- (Optional) GitHub account for fallback model access

---

## Step 1: Clone the repository

```bash
cd ~/Github
git clone https://github.com/frstrtr/aisanity.git
cd ~/Github/aisanity
```

## Step 2: Make it available system-wide

```bash
# Make the script executable
chmod +x ~/Github/aisanity/guardian.py

# Symlink to a directory in your PATH
sudo ln -sf ~/Github/aisanity/guardian.py /usr/local/bin/aisanity
```

Verify it works:

```bash
aisanity --help
```

## Step 3: Verify Ollama server connectivity

```bash
# Check the server is reachable
curl -s http://192.168.86.45:11434/api/version

# List available models
curl -s http://192.168.86.45:11434/api/tags | python3 -c "
import sys, json
for m in json.load(sys.stdin)['models']:
    print(f\"  {m['name']:40s} {m['details'].get('parameter_size','?'):>10s}\")
"
```

## Step 4: (Optional) Set up GitHub Models fallback

If the Ollama server goes down, aisanity falls back to free models via GitHub.

1. Go to https://github.com/settings/tokens
2. Create a **Personal Access Token** (classic or fine-grained)
3. Grant the **`models:read`** scope
4. Add it to your shell profile:

```bash
# Add to ~/.bashrc or ~/.zshrc
export GITHUB_TOKEN="ghp_your_token_here"
```

Reload your shell:

```bash
source ~/.bashrc
```

---

## Using aisanity in a project

### Step A: Create a memory file

In the root of your project, create `.ai-memory.md`:

```bash
cd ~/Github/my-project
cat > .ai-memory.md << 'EOF'
# PROJECT MEMORY — my-project

## Identity
- Project: my-project
- Purpose: Brief description of what the project does

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
- REQUIRED: Docstrings on all public functions
- FORBIDDEN: Any use of `print()` for logging — use `logging` module

## Forbidden Patterns
- Never use `requests` library — use `httpx` (async-first)
- Never use `os.path` — use `pathlib.Path`
- Never hardcode secrets — use environment variables

## Common Mistakes
| Wrong | Correct | Why |
|-------|---------|-----|
| `pip install X` | `uv add X` | Project uses uv |
| `import requests` | `import httpx` | Async-first HTTP |
| `os.path.join(a, b)` | `Path(a) / b` | Modern path handling |
EOF
```

### Step B: Validate AI suggestions

```bash
# Validate a single command
aisanity "pip install flask"

# Validate multi-line AI output (paste or pipe)
echo 'import requests
response = requests.get("https://api.example.com")
print(response.json())' | aisanity --check

# Validate AND get correction instructions to feed back to the AI
echo 'import requests
response = requests.get("https://api.example.com")
print(response.json())' | aisanity --check --fix

# JSON output for scripting / automation
aisanity --json "pip install flask"
```

### Step C: Use `--fix` to correct AI responses

When `--fix` is used, aisanity doesn't just report violations — it generates
a **correction prompt** you can paste back into the AI chat to fix its response:

```bash
$ aisanity --fix "pip install flask"

❌ FAILED — violations detected!
  ...

📝 CORRECTION PROMPT (paste this back to the AI):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Your previous suggestion violates the following project rules:

1. [Package Manager] You used `pip install flask` but this project
   requires `uv`. Use `uv add flask` instead.

Please revise your response to comply with all project requirements
documented in .ai-memory.md.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## MCP Server — Automatic AI Validation in VS Code

This is the **recommended way** to use aisanity. Instead of running the CLI
manually, the MCP server lets your AI agent (Claude, Copilot, etc.) call
aisanity **automatically** during conversations.

### How it works

```
You ask Claude a question in VS Code
        ↓
Claude generates a response
        ↓
Claude calls aisanity_validate automatically (MCP tool)
        ↓
aisanity checks response against .ai-memory.md via Ollama
        ↓
Violations found → Claude self-corrects before showing you
No violations   → you see the response as normal
```

### Step 1: Install the MCP server

**Option A: Global install (recommended — all projects get aisanity)**

```bash
cd ~/Github/aisanity
python3 guardian.py install-global
```

This adds aisanity to VS Code's dedicated user MCP config
(`~/.config/Code/User/mcp.json`). Every project automatically has access.

**Option B: Per-project install**

```bash
cd ~/Github/my-project
python3 ~/Github/aisanity/guardian.py init
```

This creates both `.ai-memory.md` (template) and `.vscode/mcp.json` in the
project directory.

**Manual setup** (if the commands above don't work for your setup):

Create or edit `~/.config/Code/User/mcp.json` (global) or
`.vscode/mcp.json` (per-project):

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

### Step 2: Set Claude's custom instructions

In VS Code, go to **Settings → Copilot → Chat → Instructions** and add:

> Before finalizing any response that contains code, shell commands, or
> architecture advice, call the `aisanity_validate` tool to check it against
> the project memory. If violations are found, use `aisanity_fix` to get
> correction instructions and revise your response before presenting it.
> At the start of a new conversation, call `aisanity_memory` to load
> the project's requirements.

### Step 3: Verify it works

1. Open a project that has a `.ai-memory.md` file
2. Open VS Code Chat (Ctrl+Shift+I)
3. Ask Claude to do something that would violate a rule
4. Watch the tool calls in the chat — you should see `aisanity_validate` being invoked

### MCP Tools Exposed

| Tool | Purpose |
|------|--------|
| `aisanity_validate` | Check a suggestion against `.ai-memory.md` — returns pass/fail + violations |
| `aisanity_fix` | Validate + return correction instructions if violations found |
| `aisanity_memory` | Read the project memory (so the AI can proactively follow rules) |

### Override MCP server defaults

Edit the aisanity entry in `~/.config/Code/User/mcp.json` or `.vscode/mcp.json`:

```json
{
  "servers": {
    "aisanity": {
      "type": "stdio",
      "command": "python3",
      "args": [
        "/home/user0/Github/aisanity/mcp_server.py",
        "--ollama-model", "qwen2.5:32b",
        "--ollama-url", "http://10.0.0.5:11434"
      ]
    }
  }
}
```

---

## CLI Override defaults

```bash
# Use a different Ollama model
aisanity --ollama-model qwen2.5:32b "some suggestion"

# Point to a different Ollama server
aisanity --ollama-url http://10.0.0.5:11434 "some suggestion"

# Use a different memory file
aisanity --memory /path/to/other-memory.md "some suggestion"

# Use a different GitHub fallback model
aisanity --github-model openai/gpt-4.1 "some suggestion"
```

---

## Available Ollama models on the LAN server

| Model | Size | Best for |
|-------|------|----------|
| `devstral:24b` | 14.3 GB | **Default** — code-focused, fast |
| `gemma3:27b` | 17.4 GB | General reasoning |
| `qwen2.5:32b` | 19.9 GB | Strong multilingual |
| `qwq:latest` | 19.9 GB | Deep thinking / chain-of-thought |
| `llama3.3:70b` | 42.5 GB | High accuracy, slower |
| `deepseek-r1:671b` | 404 GB | Maximum capability, slowest |

---

## Uninstall

```bash
sudo rm /usr/local/bin/aisanity
```

That's it — no packages to remove, no config files outside your projects.
