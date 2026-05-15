# Change Log

All notable changes to the "opencode-provider-bridge" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.5.0] - 2026-05-15

### Added
- **Multi-SDK auto-routing** — routes each model to the correct AI SDK (`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google`) based on per-model `apiNpm` metadata from the OpenCode registry
- **Google Generative AI support** — Google SDK integration via `@ai-sdk/google` for Gemini models served at Google-compatible endpoints
- **Anthropic SDK support** — dedicated Anthropic SDK integration via `@ai-sdk/anthropic` for models served at `/messages` endpoints (Claude, Qwen, etc.)
- **Cross-turn tool name resolution** — `toolCallNameCache` maps `toolCallId` → `toolName` from assistant tool-call messages so subsequent `ToolResultPart` conversions include the correct tool name (required by OpenAI-compatible SDKs)
- **SSE debug logging** — `verboseFetch.ts` wraps `fetch` to log HTTP request/response details and raw SSE stream data when `logLevel` is set to `debug`
- **Routing diagnostics** — verbose logging for SDK routing decisions, per-model metadata, and full converted message payloads at debug level

### Changed
- **Extracted utilities** — `simplifySchema()` and `extractTextFromToolResult()` moved from `provider.ts` to new `providerUtils.ts`
- **SDK provider caching** — split single `aiProvider` cache into three separate caches (`openaiProvider`, `anthropicProvider`, `googleProvider`); cleared individually on `setApiKey()`
- **Verbose fetch** — all SDK providers use `VERBOSE_FETCH` wrapper for debug-level SSE logging

## [0.4.1] - 2026-05-15

### Changed
- Dependency updates and minor fixes

## [0.4.0] - 2026-05-14

### Added
- **Real-time reasoning streaming** — thinking content (`LanguageModelThinkingPart`) streams as it's generated, with reasoning-start/reasoning-end markers for proper animation
- **Aggregated reasoning** — final full reasoning text emitted as `LanguageModelDataPart` with MIME `application/vnd.opencode-bridge.reasoning`
- **Status bar** — shows provider/model count (`$(hubot) OpenCode: N providers`)
- **Server auto-start** — `ensureOpencodeServer()` auto-starts a headless `opencode serve` process when no server is running, with retry on stale cached ports
- **Background warm-up** — `warmUp()` in `BridgeProvider` discovers providers asynchronously after activation; models appear when discovery completes
- **Sibling key resolution** — Zen and Go providers share API keys via sibling lookup
- **Model registration logging** — debug-level logging of every registered model with metadata
- **Proposed VS Code APIs** — `vscode.proposed.d.ts` augmentations for `LanguageModelChatProvider` interfaces
- **Extension quickstart docs** — `vsc-extension-quickstart.md` for development setup

### Changed
- **Massive provider refactor** — `OpencodeModelProvider` rewritten for multi-SDK routing, improved error classification (429→Blocked, 401/403→NotFound, 402→quota)
- **Server management** — extracted into `ensureOpencodeServer()` / `isServerAlive()` / `launchTerminal()` with health-check polling
- **Provider caching** — `getProviders()` caches results; `refreshProviderCache()` performs background refresh with change detection
- **Empty response guard** — reports minimal text to prevent Copilot "Unknown error" on empty responses

## [0.2.0] - 2026-05-13

### Added
- Publish script for VS Code Marketplace

## [0.1.9] - 2026-05-13

### Added
- **Multi-tier provider discovery** — three-tier fallback system: SDK (preferred) → models.dev + auth.json → auth.json only
- **VS Code Chat integration** — `BridgeProvider` implementing `vscode.LanguageModelChatProvider` for model selection in chat dropdown
- **OpenAI-compatible SDK routing** — uses `@ai-sdk/openai-compatible` for all models
- **Tool calling** — full tool support with JSON schema simplification (strips unsupported keys, preserves combinators)
- **Token usage display** — status bar shows prompt/completion tokens per response
- **API key management** — commands to set, change, and remove provider API keys via VS Code SecretStorage
- **Leveled logging** — `log()` with `error`/`warn`/`info`/`debug` levels via VS Code OutputChannel
- **Zero-config setup** — reads provider configurations from local OpenCode setup (SDK or `auth.json`)