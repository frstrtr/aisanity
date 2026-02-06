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
| `aisanity.ollamaUrl` | `http://192.168.86.45:11434` | Ollama server URL |
| `aisanity.ollamaModel` | `devstral:24b` | Ollama model for generation + validation |
| `aisanity.githubModel` | `openai/gpt-4o-mini` | GitHub Models fallback model |
| `aisanity.memoryFile` | `.ai-memory.md` | Project memory filename |

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
2. Select it as your active model in the chat picker
3. Every chat request from ANY participant goes through aisanity:
   - Your question is forwarded to Ollama (with project memory injected)
   - The response is validated against `.ai-memory.md`
   - If violations → auto-corrected (if enabled)
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
