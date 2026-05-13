// =============================================================================
// extension.ts  —  VS Code Extension Entry Point & BridgeProvider
// =============================================================================
//
// ORCHESTRATION FLOW:
//
//   activate()
//     ↓
//   ensureOpencodeServer()
//     ├─ SDK on :4096 ? → use it
//     ├─ SDK on :4096 ✗ → launch terminal → SDK on random port
//     └─ SDK always      → get providers
//     ↓
//   cache providers (some may lack API keys)
//     ↓
//   User picks model + sends message
//     ↓
//   provideLanguageModelChatResponse()
//     ├─ has key → delegate to sub-provider ✓
//     └─ no key  → prompt user interactively
//                   ├─ key given → store in SecretStorage → retry ✓
//                   └─ declined → LanguageModelError ✗
// =============================================================================

import * as vscode from 'vscode';
import { fallbackProviders, trySdkProviders } from './opencodeConfig.js';
import { OpencodeModelProvider } from './provider.js';
import type { ProviderEntry } from './opencodeConfig.js';
import { log, initLogger } from './logger.js';

const PKG_NAME = 'opencode-provider-bridge';
const DEFAULT_PORT = 4096;
const TERMINAL_NAME = 'opencode-bridge';

/** Format a number for status bar display (e.g. 1234 → "1.2k", 12345 → "12k"). */
function formatNum(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

// ---------------------------------------------------------------------------
// MODULE STATE
// ---------------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem;
let extContext: vscode.ExtensionContext;
let cachedProviders: Map<string, OpencodeModelProvider> | null = null;
let serverPort: number | null = null;
let serverTerminal: vscode.Terminal | null = null;

// ---------------------------------------------------------------------------
// ACTIVATION
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  initLogger();
  log('activate()');
  extContext = context;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = `${PKG_NAME}.showStatus`;
  statusBarItem.tooltip = 'OpenCode Provider Bridge';
  context.subscriptions.push(statusBarItem);

  const provider = new BridgeProvider();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('opencode-provider-bridge', provider),
  );

  // --- Refresh Models ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.refreshModels`, () => {
      cachedProviders = null;
      serverPort = null;
      provider.fireChange();
      vscode.window.showInformationMessage('OpenCode Bridge: Refreshing...');
    }),
  );

  // --- Show Status ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.showStatus`, showStatus),
  );

  // --- Set API Key (legacy management command) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.setApiKey`, () => {
      vscode.commands.executeCommand(`${PKG_NAME}.showStatus`);
    }),
  );

  // --- Add Provider (interactive) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.addProvider`, async () => {
      const providerId = await vscode.window.showInputBox({
        prompt: 'Enter the provider ID (e.g. anthropic, openai, opencode)',
        placeHolder: 'anthropic',
        ignoreFocusOut: true,
      });
      if (!providerId) return;

      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${providerId}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey) return;

      await context.secrets.store(`${PKG_NAME}.key.${providerId}`, apiKey);
      cachedProviders = null;
      provider.fireChange();
      vscode.window.showInformationMessage(`OpenCode Bridge: Saved key for "${providerId}". Refresh models to use it.`);
    }),
  );

  // --- Remove Provider ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.removeProvider`, async () => {
      const providers = await getProviders(context);
      const picks = [...providers.keys()].map(id => ({ label: id, description: providers.get(id)!.providerInfo.name }));
      const selected = await vscode.window.showQuickPick(picks, { placeHolder: 'Select provider to remove' });
      if (!selected) return;

      await context.secrets.delete(`${PKG_NAME}.key.${selected.label}`);
      cachedProviders = null;
      provider.fireChange();
      vscode.window.showInformationMessage(`OpenCode Bridge: Removed key for "${selected.label}".`);
    }),
  );

  // --- List Providers ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.listProviders`, async () => {
      const providers = await getProviders(context);
      if (providers.size === 0) {
        vscode.window.showWarningMessage('No OpenCode providers configured. Use "Add Provider" or run `opencode /connect` in terminal.');
        return;
      }
      const lines = [...providers.entries()].map(([id, p]) => {
        const models = p.providerInfo.models;
        return `${id} (${p.providerInfo.name}) — ${Object.keys(models).length} model(s)`;
      });
      vscode.window.showInformationMessage(`OpenCode Bridge providers:\n${lines.join('\n')}`);
    }),
  );
}

export function deactivate() {
  cachedProviders = null;
  // Clean up the headless server we started
  if (serverTerminal) {
    serverTerminal.dispose();
    serverTerminal = null;
  }
  serverPort = null;
  log(` deactivated — server terminal closed`);
}

// ---------------------------------------------------------------------------
// SERVER MANAGEMENT
// ---------------------------------------------------------------------------

/**
 * Try default port first. If that fails, launch opencode in a terminal
 * and wait for it to be ready. Returns the port number or null.
 */
async function ensureOpencodeServer(): Promise<number | null> {
  // Use cached port if still alive
  if (serverPort) {
    if (await isServerAlive(serverPort)) return serverPort;
    log(` Cached port ${serverPort} is dead, reconnecting...`);
    serverPort = null;
  }

  // Check default port
  if (await isServerAlive(DEFAULT_PORT)) {
    log(` Server found on default port ${DEFAULT_PORT}`);
    serverPort = DEFAULT_PORT;
    return DEFAULT_PORT;
  }

  // Launch headless server in hidden terminal
  log(` Starting headless server...`);
  const port = await launchTerminal();
  if (!port) return null;

  // Wait for server to be ready (poll up to 15s)
  log(` Waiting for server on port ${port}...`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await isServerAlive(port)) {
      log(` Server ready on port ${port}`);
      serverPort = port;
      return port;
    }
  }

  log(` Server did not start within timeout.`);
  return null;
}

async function isServerAlive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/global/health`, { signal: AbortSignal.timeout(1000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function launchTerminal(): Promise<number | null> {
  // Close any previous server terminal
  if (serverTerminal) {
    serverTerminal.dispose();
    serverTerminal = null;
  }

  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
  serverTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: new vscode.ThemeIcon('hubot'),
    hideFromUser: true,          // headless — don't show in the tab bar
  });
  serverTerminal.sendText(`opencode serve --port ${port}`);
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// PROVIDER DISCOVERY
// ---------------------------------------------------------------------------

/**
 * Get providers, trying:
 *   1. SDK via running/booted opencode server
 *   2. File-based fallback (models.dev + auth.json + bare)
 *
 * For providers without API keys, prompts user interactively and stores
 * the key in VS Code SecretStorage for future use.
 */
async function getProviders(context: vscode.ExtensionContext): Promise<Map<string, OpencodeModelProvider>> {
  if (cachedProviders) return cachedProviders;

  let entries: Map<string, ProviderEntry>;

  // Try SDK path (with server auto-start), then fallback
  const port = await ensureOpencodeServer();
  entries = port
    ? (await trySdkProviders(port, 'SDK')) ?? (await fallbackProviders())
    : await fallbackProviders();

  // Build provider instances
  const instances = new Map<string, OpencodeModelProvider>();
  for (const [providerId, entry] of entries) {
    // Try SecretStorage first
    let storedKey: string | undefined;
    try { storedKey = await context.secrets.get(`${PKG_NAME}.key.${providerId}`); } catch { /* ignore */ }

    // Zen and Go use the same API key — share across both
    if (!storedKey) {
      const siblingId = providerId === 'opencode' ? 'opencode-go' : providerId === 'opencode-go' ? 'opencode' : null;
      if (siblingId) {
        try { storedKey = await context.secrets.get(`${PKG_NAME}.key.${siblingId}`); } catch { /* ignore */ }
      }
    }

    const apiKey = storedKey || entry.credential.key || entry.credential.access || '';

    instances.set(
      providerId,
      new OpencodeModelProvider(entry.provider, apiKey, new Map(entry.models)),
    );
  }

  cachedProviders = instances;
  return instances;
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------

async function showStatus(): Promise<void> {
  // We need context for getProviders — look it up from the extension
  const ext = vscode.extensions.getExtension('community.opencode-provider-bridge');
  if (!ext) return;

  // getProviders was already called with context during activation,
  // so cachedProviders should be populated. Show from cache if available.
  const providers = cachedProviders;
  if (!providers || providers.size === 0) {
    vscode.window.showWarningMessage(
      'No OpenCode providers found. Use "OpenCode Bridge: Add Provider" or run `opencode /connect` in terminal.',
    );
    return;
  }

  const details: string[] = [];
  for (const [id, instance] of providers) {
    const modelCount = instance.providerInfo.models ? Object.keys(instance.providerInfo.models).length : 0;
    details.push(`${instance.providerInfo.name} (${modelCount} models)`);
  }

  vscode.window.showInformationMessage(
    `OpenCode Bridge: ${providers.size} provider(s): ${details.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// BRIDGE PROVIDER — implements vscode.LanguageModelChatProvider
// ---------------------------------------------------------------------------

class BridgeProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  fireChange(): void {
    this.onDidChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (options.silent && cachedProviders) {
      return this.collectModels(cachedProviders);
    }

    const providers = await getProviders(extContext);
    const allModels = await this.collectModels(providers);

    statusBarItem.text = allModels.length === 0
      ? '$(error) OpenCode: No providers'
      : `$(hubot) OpenCode: ${providers.size} providers`;
    statusBarItem.show();

    return allModels;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const providerId = model.family;
    const providers = await getProviders(extContext);
    const provider = providers.get(providerId);

    if (!provider) {
      throw vscode.LanguageModelError.NotFound(`OpenCode provider "${providerId}" not found`);
    }

    // If provider has no API key, prompt user interactively now
    if (!provider.hasApiKey) {
      const key = await this.promptForKey(providerId, provider.providerInfo.name);
      if (!key) {
        throw new vscode.LanguageModelError(
          `Cannot use "${providerId}" — no API key configured. Use "OpenCode Bridge: Add Provider" to set one.`,
        );
      }
      // Key was given — store it and update the provider instance
      await extContext.secrets.store(`${PKG_NAME}.key.${providerId}`, key);
      provider.setApiKey(key);
    }

    const innerModel: vscode.LanguageModelChatInformation = {
      ...model,
      id: model.id.startsWith(`${providerId}/`) ? model.id.slice(providerId.length + 1) : model.id,
    };

    try {
      // Reset usage tracking before this request
      provider.lastUsage = null;
      await provider.provideLanguageModelChatResponse(innerModel, messages, options, progress, token);

      // Update status bar with token usage from this response
      const pu = (provider.lastUsage ?? undefined) as { prompt: number; completion: number } | undefined;
      if (pu) {
        statusBarItem.text = `$(hubot) OpenCode | ${formatNum(pu.prompt)}→${formatNum(pu.completion)} (${formatNum(pu.prompt + pu.completion)}) tok`;
        statusBarItem.tooltip = `Provider: ${provider.providerInfo.name}\nPrompt: ${pu.prompt} tokens\nOutput: ${pu.completion} tokens\nTotal: ${pu.prompt + pu.completion} tokens`;
      } else {
        statusBarItem.text = `$(hubot) OpenCode: ${cachedProviders?.size ?? '?'} providers`;
      }
      statusBarItem.show();
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) throw err;
      throw new vscode.LanguageModelError(`OpenCode provider error: ${(err as Error).message}`);
    }
  }

  /**
   * Ask the user for an API key for a provider that has none configured.
   * Returns the key or undefined if the user declined.
   */
  private async promptForKey(providerId: string, providerName: string): Promise<string | undefined> {
    const result = await vscode.window.showInformationMessage(
      `OpenCode Bridge: "${providerName}" needs an API key to continue. Configure one now?`,
      { modal: false },
      'Enter Key',
    );
    if (result !== 'Enter Key') return undefined;

    const key = await vscode.window.showInputBox({
      title: `API Key for ${providerName}`,
      prompt: `Paste your API key for "${providerId}" — it will be stored securely in VS Code.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => v.trim().length > 0 ? null : 'Key cannot be empty',
    });

    return key?.trim() || undefined;
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const serialized = typeof text === 'string' ? text : JSON.stringify(text.content);
    return Math.max(1, Math.ceil(serialized.length / 4));
  }

  private async collectModels(
    providers: Map<string, OpencodeModelProvider>,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const allModels: vscode.LanguageModelChatInformation[] = [];
    const silentOpts: vscode.PrepareLanguageModelChatModelOptions = { silent: true };
    const ct = new vscode.CancellationTokenSource().token;

    for (const [providerId, instance] of providers) {
      const models = await instance.provideLanguageModelChatInformation(silentOpts, ct) ?? [];
      for (const m of models) {
        allModels.push({
          id: `${providerId}/${m.id}`,
          name: `${instance.providerInfo.name} - ${m.name}`,
          family: providerId,
          version: m.version,
          maxInputTokens: m.maxInputTokens,
          maxOutputTokens: m.maxOutputTokens,
          capabilities: m.capabilities,
        });
      }
    }

    return allModels;
  }
}
