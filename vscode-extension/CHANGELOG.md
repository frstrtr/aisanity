# aisanity — VS Code Extension Changelog

## 0.3.0 — Intercepting Chat Participant

- **`@aisanity` chat participant** — a true intercepting proxy:
  1. Forwards your question to Copilot with project memory injected
  2. Collects the full response (not streamed yet)
  3. Validates against `.ai-memory.md` via local Ollama
  4. If violations found → shows them, auto-asks the model to fix, re-validates
  5. If clean → streams the original response with a ✅ badge
- The model **cannot bypass** validation — every response is checked
- Multi-turn conversation support (chat history preserved)
- Re-validation of corrected responses with remaining-issue warnings

## 0.2.0 — Pure TypeScript

- Rewrote guardian + MCP server in TypeScript — **Python no longer required**
- Inline validation via output channel (no terminal spawning)
- Progress notification during validation
- Single `npm run compile` builds both extension and standalone MCP server

## 0.1.0 — Initial Release

- MCP server auto-registration (aisanity_validate, aisanity_fix, aisanity_memory tools)
- Command Palette: Init Project, Show Memory, Validate Selection
- Status bar indicator with memory file presence detection
- Configurable Ollama URL, model, GitHub fallback model, memory filename
- Bundles guardian.py and mcp_server.py (zero pip dependencies)
