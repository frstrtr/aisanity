# aisanity — VS Code Extension Changelog

## 0.6.2 — Health Check, MCP Fix, Updated Docs

- **Health Check command** — run `aisanity: Health Check` from the Command
  Palette to verify all components are configured and responding:
  - Memory file: found/missing, path, size
  - Main model: resolution, test ping with response time
  - Ollama checker: connectivity, version, model availability, test ping
  - Settings summary table
  - Overall verdict (all ok / issues detected)
- **MCP server memory file fix** — MCP server now receives the **absolute path**
  to `.ai-memory.md` instead of a relative filename; the previous `cwd` hack
  was ineffective since `McpStdioServerDefinition` has no `cwd` property
- **Default main model** — changed from `ollama` to `copilot:claude-opus-4.6`
  (Claude Opus 4.6 generates, Ollama devstral:24b validates)
- **Dynamic token limits** — queries the underlying model for its real context
  window size (Ollama `/api/show` for context_length, VS Code model API for
  maxInputTokens)
- **Updated docs** — comprehensive README, install.md, extension README with
  usage examples, health check documentation, main model configuration
  examples, and updated architecture diagrams

## 0.6.0 — Main Model Selector (Copilot + Validation)

- **New `aisanity.mainModel` setting** — choose which model generates responses
  when aisanity is selected in the model picker:
  - `"ollama"` (default) — Ollama handles both generation and validation
  - `"copilot:gpt-4o"` — Copilot GPT-4o generates, Ollama validates
  - `"copilot:claude-sonnet-4"` — Claude generates, Ollama validates
  - Any `vendor:family` VS Code model ID
- **Separation of concerns** — use your favourite powerful model for generation
  while aisanity ensures compliance with project memory via Ollama
- **Graceful fallback** — if the configured main model isn't available, aisanity
  falls back to Ollama with an explanatory error message
- **Correction loop uses main model** — auto-corrections are sent back to the
  same model that generated the original response, not just Ollama
- Updated `aisanity.ollamaModel` description to clarify it controls the
  validation model (and generation only when mainModel is "ollama")

## 0.5.0 — Settings, Model Picker Fix, Updated Docs

- **Model picker now configurable** — added `configuration` schema to the
  `languageModelChatProviders` contribution point so users can set Ollama URL
  and model directly from Manage Models UI (no extension settings needed)
- **New behavior settings:**
  - `enableValidation` — master switch for validation (default: true)
  - `enableAutoCorrection` — toggle disagreement flow (default: true)
  - `maxCorrectionRetries` — 0–3 correction attempts (default: 1)
  - `showValidationBadges` — toggle ✅/⚠️ badges (default: true)
  - `validationBackend` — choose `ollama`, `github`, or `auto` (default: ollama)
- **Per-group Ollama config** — model picker configuration takes priority over
  extension settings, allowing different configs per group
- **Correction retry loop** — configurable multi-attempt correction instead of
  single-pass
- **Report-only mode** — set `enableAutoCorrection: false` to see violations
  without auto-correction
- **Updated docs** — comprehensive README, install.md, extension README with
  model picker setup instructions, settings reference, and architecture diagrams

## 0.4.0 — Model Provider (select aisanity from model dropdown)

- **aisanity appears in the model picker** — select it as your model and ALL
  chat requests from ANY participant get proxied through validation
- No need for `@aisanity` prefix — just pick the model and use chat normally
- Uses Ollama directly for generation + validation in a single pipeline
- Three integration layers now available:
  - **Model picker** (v0.4) — transparent, all requests proxied automatically
  - **`@aisanity` participant** (v0.3) — explicit, intercepts per conversation
  - **MCP tools** (v0.1) — voluntary, model calls tools on its own

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
