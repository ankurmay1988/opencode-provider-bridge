// =============================================================================
// extension.ts  —  VS Code Extension Entry Point & BridgeProvider
// =============================================================================
//
// ARCHITECTURE:
//
//   activate()
//     ├─ register LanguageModelChatProvider (instantly)
//     ├─ begin background warm-up (server discovery, async)
//     └─ register commands
//
//   provideLanguageModelChatInformation()
//     ├─ silent=true  → return cachedModels immediately
//     ├─ silent=false + cached → return cached, trigger async refresh
//     └─ first call ever → await discovery, return results
//
//   provideLanguageModelChatResponse()
//     ├─ route to correct OpencodeModelProvider by model.family
//     ├─ no key? → prompt user, store in SecretStorage
//     └─ delegate to provider, update status bar with token usage
//
//   onDidChangeLanguageModelChatInformation fires when models change
//   (after background refresh completes)
// =============================================================================

import * as vscode from 'vscode';

import { fallbackProviders, trySdkProviders } from './opencodeConfig.js';
import { initLogger, log } from './logger.js';

import { OpencodeModelProvider } from './provider.js';
import type { ProviderEntry } from './opencodeConfig.js';

const PKG_NAME = 'opencode-provider-bridge';
const DEFAULT_PORT = 4096;
const TERMINAL_NAME = 'opencode-bridge';

/** Format a number for status bar display (e.g. 1234 → "1.2k", 12345 → "12k"). */
function formatNum(n: number): string {
  if (n >= 10000) {return `${(n / 1000).toFixed(0)}k`;}
  if (n >= 1000) {return `${(n / 1000).toFixed(1)}k`;}
  return n.toString();
}

// ---------------------------------------------------------------------------
// MODULE STATE
// ---------------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem;
let extContext: vscode.ExtensionContext;
let cachedProviders: Map<string, OpencodeModelProvider> | null = null;
let cachedModelsList: vscode.LanguageModelChatInformation[] = [];
let serverPort: number | null = null;
let serverTerminal: vscode.Terminal | null = null;
let refreshPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// ACTIVATION
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  initLogger();
  log('activate()', 'info');
  extContext = context;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = `${PKG_NAME}.showStatus`;
  statusBarItem.tooltip = 'OpenCode Provider Bridge';
  context.subscriptions.push(statusBarItem);

  const provider = new BridgeProvider();

  // Register the provider immediately — VS Code sees it as available
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('opencode-provider-bridge', provider),
  );

  // --- Begin background warm-up of provider cache ---
  // Does NOT block activation. Models appear when discovery completes.
  provider.warmUp();

  // --- Refresh Models ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.refreshModels`, () => {
      cachedProviders = null;
      cachedModelsList = [];
      serverPort = null;
      refreshPromise = null;
      provider.fireChange();
      vscode.window.showInformationMessage('OpenCode Bridge: Refreshing…');
    }),
  );

  // --- Show Status ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.showStatus`, showStatus),
  );

  // --- Set API Key for a Discovered Provider ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.setApiKey`, async () => {
      const providers = await getProviders(context);
      if (providers.size === 0) {
        vscode.window.showWarningMessage('No providers discovered. Start the opencode server first.');
        return;
      }

      const items = [...providers.entries()].map(([id, p]) => ({
        label: id,
        description: p.hasApiKey ? '✓ key set' : 'no key',
        detail: p.providerInfo.name,
        hasKey: p.hasApiKey,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a provider to set or change its API key',
      });
      if (!selected) {return;}

      const key = await vscode.window.showInputBox({
        title: `API Key for ${selected.label} (${selected.detail})`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => v.trim().length > 0 ? null : 'Key cannot be empty',
      });
      if (!key) {return;}

      await context.secrets.store(`${PKG_NAME}.key.${selected.label}`, key);
      cachedProviders = null;
      cachedModelsList = [];
      provider.fireChange();
      vscode.window.showInformationMessage(`Saved key for "${selected.label}".`);
    }),
  );

  // --- Remove Provider Key ---
  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.removeProvider`, async () => {
      const providers = await getProviders(context);
      if (providers.size === 0) {
        vscode.window.showWarningMessage('No providers to remove.');
        return;
      }
      const picks = [...providers.entries()]
        .filter(([, p]) => p.hasApiKey)
        .map(([id, p]) => ({ label: id, description: p.providerInfo.name }));
      if (picks.length === 0) {
        vscode.window.showInformationMessage('No providers with stored keys to remove.');
        return;
      }
      const selected = await vscode.window.showQuickPick(picks, { placeHolder: 'Select provider key to remove' });
      if (!selected) {return;}

      await context.secrets.delete(`${PKG_NAME}.key.${selected.label}`);
      cachedProviders = null;
      cachedModelsList = [];
      provider.fireChange();
      vscode.window.showInformationMessage(`Removed key for "${selected.label}".`);
    }),
  );
}

export function deactivate() {
  cachedProviders = null;
  cachedModelsList = [];
  if (serverTerminal) {
    serverTerminal.dispose();
    serverTerminal = null;
  }
  serverPort = null;
  log(`deactivated`, 'info');
}

// ---------------------------------------------------------------------------
// SERVER MANAGEMENT
// ---------------------------------------------------------------------------

async function ensureOpencodeServer(): Promise<number | null> {
  if (serverPort) {
    if (await isServerAlive(serverPort)) {return serverPort;}
    log(`Cached port ${serverPort} is dead, reconnecting…`, 'info');
    serverPort = null;
  }

  if (await isServerAlive(DEFAULT_PORT)) {
    log(`Server found on default port ${DEFAULT_PORT}`, 'info');
    serverPort = DEFAULT_PORT;
    return DEFAULT_PORT;
  }

  log(`Starting headless server…`, 'info');
  const port = await launchTerminal();
  if (!port) {return null;}

  log(`Waiting for server on port ${port}…`, 'info');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await isServerAlive(port)) {
      log(`Server ready on port ${port}`, 'info');
      serverPort = port;
      return port;
    }
  }

  log(`Server did not start within timeout.`, 'warn');
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
  if (serverTerminal) {
    serverTerminal.dispose();
    serverTerminal = null;
  }

  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
  serverTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: new vscode.ThemeIcon('hubot'),
    hideFromUser: true,
  });
  serverTerminal.sendText(`opencode serve --port ${port}`);
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// PROVIDER DISCOVERY & CACHING
// ---------------------------------------------------------------------------

/**
 * Get providers from cache or discover them.
 * Returns the cached map immediately if available.
 */
async function getProviders(context: vscode.ExtensionContext): Promise<Map<string, OpencodeModelProvider>> {
  if (cachedProviders) {return cachedProviders;}

  let entries: Map<string, ProviderEntry>;

  // Try SDK path (with server auto-start), then fallback
  const port = await ensureOpencodeServer();
  entries = port
    ? (await trySdkProviders(port, 'SDK')) ?? (await fallbackProviders())
    : await fallbackProviders();

  // Build provider instances
  const instances = new Map<string, OpencodeModelProvider>();
  for (const [providerId, entry] of entries) {
    let storedKey: string | undefined;
    try { storedKey = await context.secrets.get(`${PKG_NAME}.key.${providerId}`); } catch { /* ignore */ }

    // Zen and Go share the same API key
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

/**
 * Background refresh — discovers providers and rebuilds the model list.
 * Calls fireChange() on the provider only if models actually changed.
 */
async function refreshProviderCache(provider: BridgeProvider): Promise<void> {
  if (refreshPromise) {return refreshPromise;}

  refreshPromise = (async () => {
    try {
      log(`Background refresh starting…`, 'info');
      const providers = await getProviders(extContext);
      const newModels = await collectModels(providers);

      const changed = JSON.stringify(newModels) !== JSON.stringify(cachedModelsList);
      cachedModelsList = newModels;

      if (changed) {
        log(`Models changed — firing onDidChangeLanguageModelChatInformation`, 'info');
        provider.fireChange();
      }

      statusBarItem.text = cachedModelsList.length === 0
        ? '$(error) OpenCode: No providers'
        : `$(hubot) OpenCode: ${providers.size} providers`;
      statusBarItem.show();
      log(`Background refresh complete — ${providers.size} providers, ${cachedModelsList.length} models`, 'info');
    } catch (err) {
      log(`Background refresh failed: ${(err as Error).message}`, 'error');
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function collectModels(
  providers: Map<string, OpencodeModelProvider>,
): Promise<vscode.LanguageModelChatInformation[]> {
  const allModels: vscode.LanguageModelChatInformation[] = [];
  const silentOpts: vscode.PrepareLanguageModelChatModelOptions = { silent: true };
  const cts = new vscode.CancellationTokenSource();
  const token = cts.token;

  try {
    for (const [providerId, instance] of providers) {
      const models = await instance.provideLanguageModelChatInformation(silentOpts, token) ?? [];
      for (const m of models) {
        allModels.push({
          id: `${providerId}/${m.id}`,
          name: `${instance.providerInfo.name} - ${m.name}`,
          family: providerId,
          version: m.version,
          maxInputTokens: m.maxInputTokens,
          maxOutputTokens: m.maxOutputTokens,
          capabilities: m.capabilities,
          isUserSelectable: true,
        });
      }
    }
  } finally {
    cts.dispose();
  }

  return allModels;
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------

async function showStatus(): Promise<void> {
  if (!cachedProviders || cachedProviders.size === 0) {
    vscode.window.showWarningMessage(
      'No OpenCode providers found. Use "OpenCode Bridge: Set API Key" to configure one.',
    );
    return;
  }

  const details: string[] = [];
  for (const [id, instance] of cachedProviders) {
    const modelCount = instance.providerInfo.models ? Object.keys(instance.providerInfo.models).length : 0;
    const keyStatus = instance.hasApiKey ? '✓' : '✗';
    details.push(`${id} (${instance.providerInfo.name}) ${keyStatus} ${modelCount} models`);
  }

  vscode.window.showInformationMessage(
    `OpenCode Bridge: ${cachedProviders.size} provider(s)\n${details.join('\n')}`,
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

  /**
   * Begin background warm-up. Called from activate() — does not block.
   */
  warmUp(): void {
    void refreshProviderCache(this);
  }

  /**
   * Return available models.
   *
   * SILENT: returns cached models instantly — never blocks.
   * NOT SILENT: returns cache + triggers async background refresh.
   * FIRST CALL EVER: awaits discovery since cache is empty.
   */
  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Silent mode: always return cache immediately
    if (options.silent && cachedModelsList.length > 0) {
      return cachedModelsList;
    }

    // If cache is empty on first call, must wait for discovery
    if (cachedModelsList.length === 0 && !refreshPromise) {
      await refreshProviderCache(this);
      return cachedModelsList;
    }

    // If refresh is in progress, return current cache (may be empty initially)
    // and trigger another refresh to pick up changes
    if (refreshPromise) {
      // Don't await — fire background refresh and return whatever we have
      void refreshProviderCache(this);
      return cachedModelsList;
    }

    // Normal refresh
    void refreshProviderCache(this);
    return cachedModelsList;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const providerId = model.family;
    const providers = cachedProviders ?? await getProviders(extContext);
    const provider = providers.get(providerId);

    if (!provider) {
      throw vscode.LanguageModelError.NotFound(`OpenCode provider "${providerId}" not found`);
    }

    // Prompt for API key if missing
    if (!provider.hasApiKey) {
      const key = await this.promptForKey(providerId, provider.providerInfo.name);
      if (!key) {
        throw new vscode.LanguageModelError(
          `Cannot use "${providerId}" — no API key configured. Use "OpenCode Bridge: Set API Key" to set one.`,
        );
      }
      await extContext.secrets.store(`${PKG_NAME}.key.${providerId}`, key);
      provider.setApiKey(key);
    }

    // Strip prefix from model ID if present
    const innerModel: vscode.LanguageModelChatInformation = {
      ...model,
      id: model.id.startsWith(`${providerId}/`) ? model.id.slice(providerId.length + 1) : model.id,
    };

    try {
      provider.lastUsage = null;
      await provider.provideLanguageModelChatResponse(innerModel, messages, options, progress, token);

      // Update status bar with token usage
      const pu = (provider.lastUsage ?? undefined) as { prompt: number; completion: number } | undefined;
      if (pu) {
        statusBarItem.text = `$(hubot) OC ${formatNum(pu.prompt)}→${formatNum(pu.completion)} (${formatNum(pu.prompt + pu.completion)}) tok`;
        statusBarItem.tooltip = `Provider: ${provider.providerInfo.name}\nPrompt: ${pu.prompt} tokens\nOutput: ${pu.completion} tokens\nTotal: ${pu.prompt + pu.completion} tokens`;
      } else {
        statusBarItem.text = `$(hubot) OpenCode: ${cachedProviders?.size ?? '?'} providers`;
      }
      statusBarItem.show();
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {throw err;}
      throw new vscode.LanguageModelError(`OpenCode provider error: ${(err as Error).message}`);
    }
  }

  private async promptForKey(providerId: string, providerName: string): Promise<string | undefined> {
    const result = await vscode.window.showInformationMessage(
      `OpenCode Bridge: "${providerName}" needs an API key to continue. Configure one now?`,
      { modal: false },
      'Enter Key',
    );
    if (result !== 'Enter Key') {return undefined;}

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
}
