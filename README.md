# OpenCode Provider Bridge

Brings all [OpenCode](https://opencode.ai)-configured AI providers into VS Code Copilot's model picker. Uses the `@ai-sdk/openai-compatible` SDK for reliable tool calling and streaming.

## Features

- **All providers in one picker** — any provider configured in OpenCode appears in VS Code's model dropdown
- **Zero config** — auto-discovers providers from a running opencode server or local auth file
- **Secure key storage** — per-provider API keys stored in VS Code's encrypted SecretStorage
- **Server auto-start** — launches `opencode serve` headlessly if not running
- **Token usage display** — status bar shows prompt/completion tokens per response
- **Reliable tool calling** — uses `@ai-sdk/openai-compatible` for proper streaming tool call argument accumulation
- **Reasoning support** — thinking/reasoning content rendered natively via `LanguageModelThinkingPart` (VS Code 1.119+)

## Requirements

- VS Code 1.119+
- [OpenCode CLI](https://opencode.ai) installed

## Getting Started

1. Configure providers in OpenCode: `opencode /connect`
2. Install this extension
3. Open VS Code Chat → select a model from the dropdown
4. If a provider has no API key, you'll be prompted to enter one on first use

## Commands

| Command | Description |
|---------|-------------|
| `OpenCode Bridge: Refresh Model List` | Re-discover providers and models |
| `OpenCode Bridge: Show Provider Status` | Show providers, key status, and model counts |
| `OpenCode Bridge: Set API Key for a Provider` | Pick a discovered provider and set its API key |
| `OpenCode Bridge: Remove Provider Key` | Remove a stored API key for a provider |

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `opencode-provider-bridge.logLevel` | Log verbosity: `error`, `warn`, `info`, or `debug` | `info` |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full documentation on provider discovery, API calling, streaming, and key management.

## License

MIT
