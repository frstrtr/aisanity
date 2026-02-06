# aisanity — AI Memory Guardian

Catches AI context drift and hallucination by validating every AI suggestion
against a plain-text project memory file (`.ai-memory.md`).

## Features

- **MCP Server auto-registration** — the extension registers an MCP server that
  exposes `aisanity_validate`, `aisanity_fix`, and `aisanity_memory` tools to
  any AI agent (Copilot, Claude, etc.).
- **Command Palette** — `aisanity: Init Project`, `aisanity: Show Memory`,
  `aisanity: Validate Selection`.
- **Status bar indicator** — shows whether the project has a memory file.
- **Zero external dependencies** — pure TypeScript, Node.js built-ins only.

## Requirements

- **Ollama** server running on LAN (default: `http://192.168.86.45:11434`)
- Recommended model: `devstral:24b`
- No Python required — the extension is 100% TypeScript/Node.js

## Settings

| Setting                | Default                          | Description                    |
| ---------------------- | -------------------------------- | ------------------------------ |
| `aisanity.ollamaUrl`   | `http://192.168.86.45:11434`     | Ollama server URL              |
| `aisanity.ollamaModel` | `devstral:24b`                   | Ollama model for validation    |
| `aisanity.githubModel` | `openai/gpt-4o-mini`             | GitHub Models fallback         |
| `aisanity.memoryFile`  | `.ai-memory.md`                  | Project memory filename        |

## Quick Start

1. Install the extension
2. Open a project and run **aisanity: Init Project** from the Command Palette
3. Edit the generated `.ai-memory.md` with your project rules
4. The MCP server is auto-registered — AI agents will now validate against your rules
