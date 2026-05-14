# OpenCode Provider Bridge

Bring all your [OpenCode](https://opencode.ai)-configured AI providers into VS Code's Chat model picker.

Any provider you've configured in OpenCode — Zen, Go, Anthropic, OpenAI, Google, NVIDIA, Vultr, and more — appears as a selectable model in the chat dropdown, ready to use alongside GitHub Copilot.

![VS Code Chat model picker with OpenCode providers](https://github.com/ankurmathur/opencode-provider-bridge/raw/main/assets/screenshot.png)

## Quick Start

1. **Install** the extension from the VS Code Marketplace
2. **Configure** providers in OpenCode: `opencode /connect`
3. **Open** VS Code Chat → select a model from the dropdown

That's it. Providers are auto-discovered from a running `opencode serve` or your local `auth.json` file.

## Features

- **All providers, one picker** — Zen, Go, Anthropic, OpenAI, Google, and any other OpenCode provider
- **Zero config** — reads your existing OpenCode setup
- **Secure keys** — API keys stored in VS Code's encrypted SecretStorage
- **Real-time reasoning** — thinking content streams as it's generated
- **Token usage** — status bar shows prompt/completion tokens per response
- **Tool calling** — full support for tools with schema simplification

## Requirements

- VS Code **1.120+**
- [OpenCode CLI](https://opencode.ai) installed and configured (`opencode /connect`)

## Commands

| Command | What it does |
|---------|--------------|
| `OpenCode Bridge: Refresh Model List` | Re-discover providers and models |
| `OpenCode Bridge: Show Provider Status` | Show providers, key status, and model counts |
| `OpenCode Bridge: Set API Key for a Provider` | Set or change a provider's API key |
| `OpenCode Bridge: Remove Provider Key` | Remove a stored API key |

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `opencode-provider-bridge.logLevel` | `info` | Log verbosity: `error`, `warn`, `info`, or `debug` |

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for provider discovery, API calling, streaming, and key management details.

## License

MIT
