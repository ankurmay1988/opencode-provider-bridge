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
//   TIER 2 — models.dev + auth.json (fallback)
//     Fetches https://models.dev/api.json (public provider/model catalog)
//     and intersects it with the user's auth.json credentials.
//     Returns model names + capabilities from the catalog for any
//     provider the user has credentials for (nvidia, vultr, etc.).
//     Requires: internet access for the catalog fetch.
//
//   TIER 3 — auth.json only (bare fallback)
//     Creates a single placeholder model per provider with no metadata.
//     The provider shows up in VS Code's picker but the user won't
//     see model names, context limits, or capabilities.
//     Requires: nothing — works fully offline.
//
// WHY NOT JUST models.dev?
//   models.dev alone gives model metadata but no API keys (those are
//   in auth.json). models.dev + auth.json together work as well as
//   the SDK — we just lose live config (custom baseURLs, overrides).
//   We removed models.dev earlier but added it back because without
//   it Tier 3 shows only "default" model names — useless to the user.
// =============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Model, Provider } from '@opencode-ai/sdk';

import { createOpencodeClient } from '@opencode-ai/sdk';
import { log as logger } from './logger.js';

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
// SDK-TO-LOCAL TYPE MAPPERS
// ---------------------------------------------------------------------------

function sdkModelToDevModel(model: Model): ModelsDevModel {
  return {
    id: model.id,
    name: model.name,
    family: model.providerID,
    apiUrl: model.api?.url,            // exact endpoint from opencode's registry
    apiNpm: model.api?.npm,            // exact npm package from opencode's registry
    tool_call: model.capabilities.toolcall,
    reasoning: model.capabilities.reasoning,
    attachment: model.capabilities.attachment,
    modalities: {
      input: Object.entries(model.capabilities.input)
        .filter(([, v]) => v).map(([k]) => k),
      output: Object.entries(model.capabilities.output)
        .filter(([, v]) => v).map(([k]) => k),
    },
    limit: {
      context: model.limit.context,
      output: model.limit.output,
    },
  };
}

function sdkProviderToEntry(sp: Provider): ProviderEntry | null {
  const models: [string, ModelsDevModel][] = [];

  for (const [rawId, model] of Object.entries(sp.models)) {
    models.push([rawId, sdkModelToDevModel(model)]);
  }

  if (models.length === 0) {return null;}

  const baseURL = sp.options?.baseURL as string | undefined;
  const apiURL = sp.options?.api as string | undefined;

  return {
    provider: {
      id: sp.id,
      name: sp.name,
      api: baseURL ?? apiURL,
      env: sp.env,
      models: Object.fromEntries(models),
    },
    credential: {
      type: 'api',
      key: sp.key,
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
  const log = (msg: string) => logger(` ${msg}`);
  const url = `http://localhost:${port ?? DEFAULT_SDK_PORT}`;
  logger(`${tag}: SDK discovery → ${url}`);

  try {
    const client = createOpencodeClient({ baseUrl: url });
    logger(`${tag}: client created, calling config.providers()...`);

    const result = await client.config.providers() as { data?: { providers: Provider[] } };
    const providers = result?.data?.providers;
    logger(`${tag}: returned ${providers?.length ?? 0} provider(s)`);

    if (!providers?.length) {
      logger(`${tag}: no providers returned.`);
      return null;
    }

    for (const sp of providers) {
      const modelCount = Object.keys(sp.models).length;
      logger(`${tag}:  [${sp.id}] "${sp.name}" source=${sp.source} hasKey=${!!sp.key} models=${modelCount}`);
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
      const keyStatus = sp.key ? 'keyed' : 'no key';
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
// TIER 2: MODELS.DEV + AUTH.JSON
// ---------------------------------------------------------------------------

export function readOpencodeAuth(): OpencodeAuth {
  for (const p of AUTH_FILE_PATHS) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      return JSON.parse(raw);
    } catch { continue; }
  }
  return {};
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
  const log = (msg: string) => logger(` ${msg}`);
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
  const log = (msg: string) => logger(` ${msg}`);
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
  const [auth, catalog] = await Promise.all([
    Promise.resolve().then(() => readOpencodeAuth()),
    fetchModelsCatalogger(),
  ]);
  const ids = Object.keys(auth);
  logger(` auth.json: ${ids.length} provider(s) - ${ids.join(', ') || '(none)'}`);

  // Tier 2: models.dev + auth.json
  const catalogResult = filterModelsForProviders(catalog, auth);
  if (catalogResult) {return catalogResult;}

  // Tier 3: bare fallback
  logger(` TIER 3: bare fallback - no catalog available`);
  const bareResult = makeBareFallback(auth);
  if (bareResult) {return bareResult;}

  logger(` No providers found.`);
  return new Map();
}
