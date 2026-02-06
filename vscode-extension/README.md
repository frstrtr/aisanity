# aisanity — AI Memory Guardian (VS Code Extension)

Catches AI context drift and hallucination by validating every AI suggestion
against a plain-text project memory file (`.ai-memory.md`).

## Features

### Three Integration Layers

1. **Model Picker** — select aisanity from the VS Code model dropdown and ALL
   chat requests get proxied through validation automatically
2. **`@aisanity` Chat Participant** — type `@aisanity` before your question to
   validate that specific conversation
3. **MCP Server** — auto-registered tools (`aisanity_validate`, `aisanity_fix`,
   `aisanity_memory`) available to any AI agent

### Additional Features

- **Command Palette** — `aisanity: Init Project`, `aisanity: Show Memory`,
  `aisanity: Validate Selection`
- **Status bar indicator** — shows whether the project has a memory file
- **Configurable disagreement flow** — enable/disable auto-correction when
  violations are found
- **Zero external dependencies** — pure TypeScript, Node.js built-ins only

## Quick Start

### Step 1: Add aisanity to the model picker

1. Open the Chat view (Ctrl+Shift+I)
2. Click the model picker dropdown at the top
3. Click **Manage Models** (gear icon)
4. Find **aisanity** in the provider list and click **+**
5. Enter your Ollama URL (e.g., `http://192.168.86.45:11434`) and model name (e.g., `devstral:24b`)
6. Select the newly added **aisanity** model from the dropdown
7. Start chatting — every response is now validated!

### Step 2: Create project memory

Run **aisanity: Init Project** from the Command Palette (Ctrl+Shift+P), then
edit the generated `.ai-memory.md` with your project-specific rules.

### Alternative: Use as chat participant

Instead of using the model picker, you can type `@aisanity` before any question:

```
@aisanity how do I install flask in this project?
```

## Requirements

- **Ollama** server running on LAN (default: `http://192.168.86.45:11434`)
- Recommended model: `devstral:24b`
- No Python required — the extension is 100% TypeScript/Node.js

## Settings

### Connection

| Setting | Default | Description |
|---------|---------|-------------|
| `aisanity.mainModel` | `ollama` | Main model for response generation (see below) |
| `aisanity.ollamaUrl` | `http://192.168.86.45:11434` | Ollama server URL |
| `aisanity.ollamaModel` | `devstral:24b` | Ollama model for validation (and generation when mainModel is "ollama") |
| `aisanity.githubModel` | `openai/gpt-4o-mini` | GitHub Models fallback model |
| `aisanity.memoryFile` | `.ai-memory.md` | Project memory filename |

### Main Model

The `aisanity.mainModel` setting controls which model generates responses when
aisanity is selected in the model picker:

| Value | Generation | Validation |
|-------|-----------|------------|
| `ollama` (default) | Ollama (`ollamaModel`) | Ollama (`ollamaModel`) |
| `copilot:gpt-4o` | Copilot GPT-4o | Ollama (`ollamaModel`) |
| `copilot:claude-sonnet-4` | Claude Sonnet 4 | Ollama (`ollamaModel`) |
| Any `vendor:family` | That VS Code model | Ollama (`ollamaModel`) |

This lets you use powerful cloud models (Copilot, etc.) for generation while
aisanity enforces project rules via your local Ollama validator.

### Behavior

| Setting | Default | Description |
|---------|---------|-------------|
| `aisanity.enableValidation` | `true` | Turn validation on/off globally |
| `aisanity.enableAutoCorrection` | `true` | Auto-correct violations (disagreement flow) |
| `aisanity.maxCorrectionRetries` | `1` | Max correction attempts (0–3) |
| `aisanity.showValidationBadges` | `true` | Show ✅/⚠️ badges in responses |
| `aisanity.validationBackend` | `ollama` | Backend: `ollama`, `github`, or `auto` |

### Disagreement Flow

The disagreement flow is what happens when aisanity detects that the AI's response
violates your project rules:

```
AI response → Validate → Violations found!
  → Send violations back to model
  → Model generates corrected response
  → Re-validate (up to maxCorrectionRetries)
  → Show validated response
```

**To disable auto-correction** (report-only mode), set either:
- `aisanity.enableAutoCorrection: false` — shows violations + original response
- `aisanity.maxCorrectionRetries: 0` — same effect

**To disable all validation**, set:
- `aisanity.enableValidation: false` — pure Ollama proxy, no checking

## How the Model Picker Works

When you add aisanity as a model provider:

1. You configure it with your Ollama server URL and model name
2. (Optional) Set `aisanity.mainModel` to a VS Code model ID like `copilot:gpt-4o`
3. Select aisanity as your active model in the chat picker
4. Every chat request from ANY participant goes through aisanity:
   - Your question is forwarded to the **main model** (with project memory injected)
   - The response is validated against `.ai-memory.md` via **Ollama**
   - If violations → auto-corrected by the same main model
   - Clean response streamed back with ✅ badge

The model picker configuration takes priority over extension settings for
Ollama URL and model name. This lets you have different configurations for
different model picker groups.

## Commands

| Command | Description |
|---------|-------------|
| `aisanity: Init Project` | Create `.ai-memory.md` template in workspace |
| `aisanity: Show Memory` | Open the project memory file |
| `aisanity: Validate Selection` | Validate selected text against project memory |
