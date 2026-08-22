// =============================================================================
// opencodeConfig.ts  —  Provider & Model Discovery
// =============================================================================
//
// DISCOVERY TIERS (tried in order until one succeeds):
//
//   TIER 1 — SDK (preferred)
//     Connects to a running opencode server via @opencode-ai/sdk.
//     Returns live provider configs with API keys, all model names,
//     capabilities (toolcall, vision, reasoning), context limits, etc.
//     Requires: opencode CLI/desktop running on :4096.
//
//   TIER 2 — opencode.json / models.dev + auth.json (fallback)
//     Reads local opencode.json / opencode.jsonc configurations and/or
//     fetches https://models.dev/api.json (public provider/model catalog)
//     intersected with credentials from auth.json.
//     Returns model names + capabilities from config/catalog for any
//     configured provider.
//
//   TIER 3 — auth.json only (bare fallback)
//     Creates a single placeholder model per provider with no metadata.
//     The provider shows up in VS Code's picker but the user won't
//     see model names, context limits, or capabilities.
//     Requires: nothing — works fully offline.
// =============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Model, Provider } from '@opencode-ai/sdk';

import { createOpencodeClient } from '@opencode-ai/sdk';

type LogFn = (msg: string) => void;
let logFn: LogFn = () => {};
export function setConfigLogger(fn: LogFn) { logFn = fn; }
function logger(msg: string) { logFn(msg); }

const PKG_NAME = 'opencode-provider-bridge';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface ProviderCredential {
  type: 'api' | 'oauth';
  key?: string;
  access?: string;
}

export interface OpencodeAuth {
  [providerId: string]: ProviderCredential;
}

export interface ModelsDevModel {
  id: string;
  name: string;
  family: string;
  /** Exact API base URL from opencode's model registry (SDK Model.api.url). */
  apiUrl?: string;
  /** npm package from opencode's model registry (e.g. @ai-sdk/openai-compatible). */
  apiNpm?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  modalities?: { input: string[]; output: string[] };
  limit?: { context?: number; output?: number };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  api?: string;
  env?: string[];
  npm?: string;
  models: Record<string, ModelsDevModel>;
}

export interface ModelsDevCatalog {
  [providerId: string]: ModelsDevProvider;
}

export type ProviderEntry = {
  provider: ModelsDevProvider;
  credential: ProviderCredential;
  models: [string, ModelsDevModel][];
};

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const DEFAULT_SDK_PORT = 4096;
const MODELS_DEV_URL = 'https://models.dev/api.json';

const CONFIG_FILE_PATHS = [
  path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
  path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
  path.join(os.homedir(), '.opencode', 'opencode.json'),
  path.join(os.homedir(), '.opencode', 'opencode.jsonc'),
  path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.json'),
  path.join(process.cwd(), 'opencode.json'),
  path.join(process.cwd(), 'opencode.jsonc'),
  path.join(process.cwd(), '.opencode', 'opencode.json'),
  path.join(process.cwd(), '.opencode', 'opencode.jsonc'),
];

const AUTH_FILE_PATHS = [
  path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
  path.join(os.homedir(), '.opencode', 'auth.json'),
  path.join(os.homedir(), '.config', 'opencode', 'auth.json'),
];

/**
 * Hardcoded entries for opencode-managed providers (Zen, Go).
 * These may not appear in the public models.dev catalog so we keep
 * them here as a last-resort fallback.
 */
const KNOWN_PROVIDERS: Record<string, { name: string; api: string }> = {
  opencode:      { name: 'OpenCode Zen', api: 'https://opencode.ai/zen/v1' },
  'opencode-go': { name: 'OpenCode Go',  api: 'https://opencode.ai/go/v1' },
};

// ---------------------------------------------------------------------------
// JSONC & CONFIG HELPERS
// ---------------------------------------------------------------------------

export function parseJsonc(content: string): any {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(stripped);
}

export function readOpencodeConfig(): Record<string, unknown> | null {
  for (const p of CONFIG_FILE_PATHS) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      try {
        return JSON.parse(raw);
      } catch {
        return parseJsonc(raw);
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SDK-TO-LOCAL TYPE MAPPERS
// ---------------------------------------------------------------------------

export function sdkModelToDevModel(model: Model): ModelsDevModel {
  return {
    id: model.api?.id || model.id,
    name: model.name,
    family: model.providerID,
    apiUrl: model.api?.url,            // exact endpoint from opencode's registry
    apiNpm: model.api?.npm,            // exact npm package from opencode's registry
    tool_call: model.capabilities?.toolcall ?? (model as any).tool_call,
    reasoning: model.capabilities?.reasoning ?? (model as any).reasoning,
    attachment: model.capabilities?.attachment ?? (model as any).attachment,
    modalities: model.capabilities?.input && model.capabilities?.output ? {
      input: Object.entries(model.capabilities.input)
        .filter(([, v]) => v).map(([k]) => k),
      output: Object.entries(model.capabilities.output)
        .filter(([, v]) => v).map(([k]) => k),
    } : (model as any).modalities,
    limit: {
      context: model.limit?.context ?? (model as any).limit?.context,
      output: model.limit?.output ?? (model as any).limit?.output,
    },
  };
}

export function sdkProviderToEntry(sp: Provider): ProviderEntry | null {
  const models: [string, ModelsDevModel][] = [];

  for (const [rawId, model] of Object.entries(sp.models || {})) {
    models.push([rawId, sdkModelToDevModel(model)]);
  }

  if (models.length === 0) {return null;}

  const options = sp.options as Record<string, unknown> | undefined;
  const baseURL = (options?.baseURL ?? options?.baseUrl ?? options?.api ?? options?.apiUrl) as string | undefined;
  const npm = (options?.npm ?? (sp as any).npm) as string | undefined;
  const apiKey = (sp.key ?? options?.apiKey ?? options?.key ?? options?.token ?? options?.authToken) as string | undefined;

  return {
    provider: {
      id: sp.id,
      name: sp.name || sp.id,
      api: baseURL,
      env: sp.env,
      npm,
      models: Object.fromEntries(models),
    },
    credential: {
      type: 'api',
      key: apiKey,
    },
    models,
  };
}

// ---------------------------------------------------------------------------
// TIER 1: SDK-BASED DISCOVERY
// ---------------------------------------------------------------------------

/**
 * Try SDK discovery on a given port.
 * @param port — if set, connects to localhost:{port}; if omitted, uses default 4096
 * @param logPrefix — optional label for log lines (e.g. "retry")
 */
export async function trySdkProviders(port?: number, logPrefix?: string): Promise<Map<string, ProviderEntry> | null> {
  const tag = logPrefix ?? 'TIER 1';
  const url = `http://localhost:${port ?? DEFAULT_SDK_PORT}`;
  logger(`${tag}: SDK discovery → ${url}`);

  try {
    const headers: Record<string, string> = {};
    if (process.env.OPENCODE_SERVER_PASSWORD) {
      const auth = Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }
    const client = createOpencodeClient({ baseUrl: url, headers });
    logger(`${tag}: client created, calling config.providers()...`);

    const result = await client.config.providers() as { data?: { providers: Provider[] } };
    const providers = result?.data?.providers;
    logger(`${tag}: returned ${providers?.length ?? 0} provider(s)`);

    if (!providers?.length) {
      logger(`${tag}: no providers returned.`);
      return null;
    }

    for (const sp of providers) {
      const modelCount = Object.keys(sp.models || {}).length;
      const key = sp.key ?? (sp.options as any)?.apiKey ?? (sp.options as any)?.key;
      logger(`${tag}:  [${sp.id}] "${sp.name}" source=${sp.source} hasKey=${!!key} models=${modelCount}`);
    }

    const configured = new Map<string, ProviderEntry>();
    for (const sp of providers) {
      const entry = sdkProviderToEntry(sp);
      if (!entry) {
        logger(`${tag}:  Skipping "${sp.id}": 0 models`);
        continue;
      }
      // If the SDK didn't return an API endpoint, check known providers
      if (!entry.provider.api) {
        const known = KNOWN_PROVIDERS[sp.id];
        if (known) {entry.provider.api = known.api;}
      }
      configured.set(sp.id, entry);
      const keyStatus = entry.credential.key ? 'keyed' : 'no key';
      logger(`${tag}:  Included "${sp.id}": ${entry.models.length} models (${keyStatus})`);
    }

    logger(`${tag}: done — ${configured.size} provider(s)`);
    return configured.size > 0 ? configured : null;
  } catch (err) {
    logger(`${tag} failed: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TIER 2: CONFIG / MODELS.DEV + AUTH.JSON
// ---------------------------------------------------------------------------

export function readOpencodeAuth(): OpencodeAuth {
  const auth: OpencodeAuth = {};

  // First check opencode.json / opencode.jsonc
  const config = readOpencodeConfig();
  if (config?.provider && typeof config.provider === 'object') {
    for (const [providerId, rawProvider] of Object.entries(config.provider as Record<string, any>)) {
      if (!rawProvider || typeof rawProvider !== 'object') {continue;}
      const options = rawProvider.options as Record<string, unknown> | undefined;
      const key = (options?.apiKey ?? options?.key ?? options?.token ?? rawProvider.key) as string | undefined;
      if (key) {
        auth[providerId] = { type: 'api', key };
      }
    }
  }

  // Then merge auth.json if present
  for (const p of AUTH_FILE_PATHS) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        Object.assign(auth, parsed);
        break;
      }
    } catch { continue; }
  }
  return auth;
}

export function configProvidersFromConfigFile(config: Record<string, unknown> | null): Map<string, ProviderEntry> {
  const result = new Map<string, ProviderEntry>();
  if (!config || typeof config !== 'object' || !config.provider || typeof config.provider !== 'object') {
    return result;
  }

  for (const [providerId, rawProvider] of Object.entries(config.provider as Record<string, any>)) {
    if (!rawProvider || typeof rawProvider !== 'object') {continue;}

    const options = rawProvider.options as Record<string, unknown> | undefined;
    const baseURL = (options?.baseURL ?? options?.baseUrl ?? options?.api ?? options?.apiUrl) as string | undefined;
    const npm = (rawProvider.npm ?? options?.npm) as string | undefined;
    const apiKey = (options?.apiKey ?? options?.key ?? options?.token ?? rawProvider.key) as string | undefined;

    const models: [string, ModelsDevModel][] = [];
    if (rawProvider.models && typeof rawProvider.models === 'object') {
      for (const [modelKey, rawModel] of Object.entries(rawProvider.models as Record<string, any>)) {
        if (!rawModel || typeof rawModel !== 'object') {continue;}
        const id = rawModel.id || `${providerId}/${modelKey}`;
        const name = rawModel.name || modelKey;
        const toolCall = rawModel.tool_call ?? rawModel.capabilities?.toolcall ?? true;
        const reasoning = rawModel.reasoning ?? rawModel.capabilities?.reasoning ?? false;
        const attachment = rawModel.attachment ?? rawModel.capabilities?.attachment ?? false;
        const modalities = rawModel.modalities ?? (rawModel.capabilities?.input && rawModel.capabilities?.output ? {
          input: Object.entries(rawModel.capabilities.input).filter(([, v]) => v).map(([k]) => k),
          output: Object.entries(rawModel.capabilities.output).filter(([, v]) => v).map(([k]) => k),
        } : undefined);
        const limit = rawModel.limit ? {
          context: rawModel.limit.context,
          output: rawModel.limit.output,
        } : undefined;

        models.push([
          modelKey,
          {
            id,
            name,
            family: providerId,
            apiUrl: rawModel.apiUrl ?? rawModel.api?.url,
            apiNpm: rawModel.apiNpm ?? rawModel.api?.npm ?? npm,
            tool_call: toolCall,
            reasoning,
            attachment,
            modalities,
            limit,
          },
        ]);
      }
    }

    if (models.length === 0) {
      continue;
    }

    result.set(providerId, {
      provider: {
        id: providerId,
        name: rawProvider.name || providerId,
        api: baseURL,
        npm,
        models: Object.fromEntries(models),
      },
      credential: {
        type: 'api',
        key: apiKey,
      },
      models,
    });
  }

  return result;
}

/**
 * Fetch the public models.dev catalog.
 * Non-blocking — if the fetch fails we return {} and move to Tier 3.
 */
async function fetchModelsCatalogger(): Promise<ModelsDevCatalog> {
  logger(` TIER 2: fetching models.dev catalog...`);
  try {
    const resp = await fetch(MODELS_DEV_URL);
    if (!resp.ok) {
      logger(`  models.dev returned HTTP ${resp.status}`);
      return {};
    }
    const catalog = await resp.json() as ModelsDevCatalog;
    const count = Object.keys(catalog).length;
    logger(`  models.dev loaded: ${count} provider(s) in catalog`);
    return catalog;
  } catch (err) {
    logger(`  models.dev fetch failed: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Intersect auth.json credentials with the models.dev catalog.
 * Every provider with a credential AND a catalog entry gets included
 * with its full model list (names, capabilities, limits).
 */
function filterModelsForProviders(
  catalog: ModelsDevCatalog,
  auth: OpencodeAuth,
): Map<string, ProviderEntry> | null {
  const result = new Map<string, ProviderEntry>();

  for (const [providerId, credential] of Object.entries(auth)) {
    const providerInfo = catalog[providerId];
    if (!providerInfo) {
      logger(`  "${providerId}" NOT in models.dev catalog — skipping`);
      continue;
    }

    const supportedModels = Object.entries(providerInfo.models);
    if (supportedModels.length === 0) {
      logger(`  "${providerId}" has 0 models in catalog — skipping`);
      continue;
    }

    result.set(providerId, {
      provider: providerInfo,
      credential,
      models: supportedModels,
    });

    logger(`  Included "${providerId}": ${supportedModels.length} models from catalog`);
  }

  return result.size > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// TIER 3: AUTH.JSON ONLY (BARE FALLBACK)
// ---------------------------------------------------------------------------

/**
 * Every provider in auth.json gets a single placeholder model.
 * No model metadata — the user sees the provider name but all models
 * appear as "default". This is the last resort when SDK and models.dev
 * are both unavailable.
 */
function makeBareFallback(auth: OpencodeAuth): Map<string, ProviderEntry> | null {
  const result = new Map<string, ProviderEntry>();

  for (const [providerId, credential] of Object.entries(auth)) {
    // For known providers (Zen, Go) use hardcoded name + API URL
    const known = KNOWN_PROVIDERS[providerId];
    const name = known?.name ?? providerId;
    const api = known?.api ?? undefined;

    result.set(providerId, {
      provider: { id: providerId, name, api, models: {} },
      credential,
      models: [['default', {
        id: `${providerId}/default`,
        name,
        family: providerId,
        tool_call: true,
      }]],
    });

    logger(`  Included "${providerId}" (${name}) — bare fallback, 1 placeholder model`);
  }

  return result.size > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Fallback discovery (Tiers 2 + 3) — used when the SDK is unavailable.
 * Does NOT try the SDK path; that's handled by extension.ts with server mgmt.
 */
export async function fallbackProviders(): Promise<Map<string, ProviderEntry>> {
  const config = readOpencodeConfig();
  const configMap = configProvidersFromConfigFile(config);

  const [auth, catalog] = await Promise.all([
    Promise.resolve().then(() => readOpencodeAuth()),
    fetchModelsCatalogger(),
  ]);
  const ids = Object.keys(auth);
  logger(` config/auth discovery: ${configMap.size} config provider(s), ${ids.length} auth provider(s) - ${ids.join(', ') || '(none)'}`);

  // Tier 2: models.dev + auth.json
  const catalogResult = filterModelsForProviders(catalog, auth);

  const merged = new Map<string, ProviderEntry>();
  if (catalogResult) {
    for (const [k, v] of catalogResult) {
      merged.set(k, v);
    }
  }
  for (const [k, v] of configMap) {
    merged.set(k, v);
  }

  if (merged.size > 0) {
    return merged;
  }

  // Tier 3: bare fallback
  logger(` TIER 3: bare fallback - no catalog available`);
  const bareResult = makeBareFallback(auth);
  if (bareResult) {return bareResult;}

  logger(` No providers found.`);
  return new Map();
}
