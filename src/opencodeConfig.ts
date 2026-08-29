// =============================================================================
// opencodeConfig.ts  —  Provider & Model Discovery
// =============================================================================
//
// DISCOVERY — SDK ONLY (mandatory opencode server)
//
//   The opencode server is the single source of truth for providers and
//   models. We connect to a running server via @opencode-ai/sdk and read
//   live provider configs: API keys, all model names, capabilities
//   (toolcall, vision, reasoning), context limits, per-model api.url and
//   api.npm (used for SDK routing), and cost metadata.
//
//   There is NO fallback to models.dev or auth.json. If the server is not
//   running, serverManager.ts starts `opencode serve` (or shows a retryable
//   error popup when the CLI is missing). Discovery returns an empty map
//   when no server is available.
// =============================================================================

import type { Model, Provider } from '@opencode-ai/sdk';

import { createOpencodeClient } from '@opencode-ai/sdk';
import { log as logger } from './logger.js';
import vscode from 'vscode';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface ProviderCredential {
  type: 'api' | 'oauth';
  key?: string;
  access?: string;
}

export interface ModelsDevModel extends vscode.LanguageModelChatInformation {
  family: string;
  /** Exact API base URL from opencode's model registry (SDK Model.api.url). */
  apiUrl?: string;
  /** npm package from opencode's model registry (e.g. @ai-sdk/openai-compatible). */
  apiNpm?: string;
  reasoning?: boolean;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  api?: string;
  env?: string[];
  npm?: string;
  models: Record<string, ModelsDevModel>;
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

/**
 * Hardcoded entries for opencode-managed providers (Zen, Go).
 * Used to fill in the provider-level API URL when the SDK does not
 * return one for these providers.
 */
const KNOWN_PROVIDERS: Record<string, { name: string; api: string }> = {
  opencode:      { name: 'OpenCode Zen', api: 'https://opencode.ai/zen/v1' },
  'opencode-go': { name: 'OpenCode Go',  api: 'https://opencode.ai/go/v1' },
};

// ---------------------------------------------------------------------------
// COST UNITS
// ---------------------------------------------------------------------------
//
// opencode reports model cost in USD per 1M tokens (its Model.cost fields map
// to models.dev, and its TUI renders them with a "$" sign). VS Code's model
// management UI instead expects AI credits per 1M tokens, where 1 credit =
// $0.01 USD (the same convention GitHub Copilot uses). We therefore convert
// USD → credits (× 100) for the cost fields, and also expose a human-readable
// dollar `pricing` label.

/** 1 AI credit = $0.01 USD (GitHub Copilot / VS Code convention). */
const USD_PER_CREDIT = 0.01;

/** Converts a USD-per-1M-tokens price to VS Code AI credits per 1M tokens. */
function usdToCredits(usd: number | undefined): number | undefined {
  if (usd === undefined || usd === null || !Number.isFinite(usd)) {return undefined;}
  return usd / USD_PER_CREDIT;
}

/** Formats a USD-per-1M-tokens price for display, e.g. "$0.14/M". */
function formatUsdPerM(usd: number | undefined): string | undefined {
  if (usd === undefined || usd === null || !Number.isFinite(usd)) {return undefined;}
  return `$${usd.toFixed(2)}/M`;
}

// ---------------------------------------------------------------------------
// SDK-TO-LOCAL TYPE MAPPERS
// ---------------------------------------------------------------------------

function sdkModelToDevModel(sp: Provider, model: Model): ModelsDevModel {
  // opencode reports cost in USD per 1M tokens; VS Code expects AI credits
  // per 1M tokens (1 credit = $0.01). Convert, and keep a dollar label too.
  const inputUsd = model.cost?.input;
  const outputUsd = model.cost?.output;
  const cacheReadUsd = model.cost?.cache?.read;
  const cacheWriteUsd = model.cost?.cache?.write;
  const longInputUsd = model.cost?.experimentalOver200K?.input;
  const longOutputUsd = model.cost?.experimentalOver200K?.output;
  const longCacheReadUsd = model.cost?.experimentalOver200K?.cache?.read;
  const longCacheWriteUsd = model.cost?.experimentalOver200K?.cache?.write;

  const pricingParts: string[] = [];
  const inLabel = formatUsdPerM(inputUsd);
  const outLabel = formatUsdPerM(outputUsd);
  if (inLabel) {pricingParts.push(`In: ${inLabel}`);}
  if (outLabel) {pricingParts.push(`Out: ${outLabel}`);}

  return {
    id: `${model.providerID}/${model.id}`,
    name: `${sp.name} - ${model.name}`,
    family: model.providerID,
    apiUrl: model.api?.url,            // exact endpoint from opencode's registry
    apiNpm: model.api?.npm,
    maxInputTokens: model.limit.context,
    maxOutputTokens: model.limit.output,
    isUserSelectable: true,
    detail: model.name,
    capabilities: {
      imageInput: model.capabilities.input.image,
      toolCalling: model.capabilities.toolcall,
    },
    reasoning: model.capabilities.reasoning,
    version: "1.0.0",
    pricing: pricingParts.length > 0 ? pricingParts.join(' · ') : undefined,
    cacheCost: usdToCredits(cacheReadUsd),
    cacheWriteCost: usdToCredits(cacheWriteUsd),
    inputCost: usdToCredits(inputUsd),
    outputCost: usdToCredits(outputUsd),
    longContextCacheCost: usdToCredits(longCacheReadUsd),
    longContextCacheWriteCost: usdToCredits(longCacheWriteUsd),
    longContextInputCost: usdToCredits(longInputUsd),
    longContextOutputCost: usdToCredits(longOutputUsd),
  };
}

function sdkProviderToEntry(sp: Provider): ProviderEntry | null {
  const models: [string, ModelsDevModel][] = [];

  for (const [rawId, model] of Object.entries(sp.models)) {
    models.push([rawId, sdkModelToDevModel(sp, model)]);
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
// SDK-BASED DISCOVERY
// ---------------------------------------------------------------------------

/**
 * Try SDK discovery on a given port.
 * @param port — if set, connects to localhost:{port}; if omitted, uses default 4096
 * @param logPrefix — optional label for log lines (e.g. "retry")
 */
export async function trySdkProviders(port?: number, logPrefix?: string): Promise<Map<string, ProviderEntry> | null> {
  const tag = logPrefix ?? 'SDK';
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
