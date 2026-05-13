# OpenCode Provider Bridge

Brings all [OpenCode](https://opencode.ai)-configured AI providers into VS Code Copilot's model picker. Use Anthropic, OpenAI, Google, NVIDIA, Vultr, and 70+ other providers directly in VS Code Chat.

## Features

- 🎯 **All providers in one picker** — any provider configured in OpenCode appears in VS Code's model dropdown
- ⚡ **Zero config** — auto-discovers providers from a running opencode server
- 🔒 **Secure key storage** — API keys stored in VS Code's encrypted SecretStorage
- 🚀 **Server auto-start** — launches `opencode serve` headlessly if not running
- 📊 **Token usage display** — status bar shows prompt/completion tokens

## Requirements

- VS Code 1.104+
- [OpenCode CLI](https://opencode.ai) installed

## Getting Started

1. Configure providers in OpenCode: `opencode /connect`
2. Install this extension
3. Open VS Code Chat → select a model from the dropdown

## Commands

| Command | Description |
|---------|-------------|
| `OpenCode Bridge: Refresh Model List` | Re-discover providers and models |
| `OpenCode Bridge: Show Status` | Show provider and model counts |
| `OpenCode Bridge: Add Provider` | Add a provider ID + API key |
| `OpenCode Bridge: Remove Provider` | Remove a stored API key |

## Extension Settings

This extension contributes the following settings:

- `opencodeBridge.autoStart` — Auto-start opencode server if not running (default: `true`)
- `opencodeBridge.serverPort` — Port for opencode server (default: `4096`)

## Known Issues

- Models without `tool_call` capability are excluded
- Context window indicator may show 0% for third-party providers

## Release Notes

### 1.0.0

Initial release

## License

MIT
