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

/**
 * A single reasoning variant from the opencode server's `Model.variants`.
 *
 * The SDK's `Model` type is stale and doesn't declare `variants`, so we model
 * the shapes observed from the live server. Each value is already in the exact
 * shape of the AI SDK provider options for the model's SDK (`api.npm`):
 *   { reasoningEffort: "low" }                                  → openai-compatible
 *   { reasoningEffort: "low", reasoningSummary: "auto", ... }   → openai-compatible
 *   { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } → google
 *   { thinking: { type: "adaptive", display: "summarized" }, effort: "high" } → anthropic
 *   { thinking: { type: "enabled", budgetTokens: 16000 } }      → anthropic
 *   { thinking: { type: "disabled" } }                          → openai-compatible (minimax)
 */
export type ReasoningVariant = {
  reasoningEffort?: string;
  reasoningSummary?: string;
  include?: string[];
  effort?: string;
  thinking?: {
    type: string;
    display?: string;
    budgetTokens?: number;
  };
  thinkingConfig?: {
    includeThoughts?: boolean;
    thinkingLevel?: string;
  };
};

/** Per-model reasoning variants keyed by the effort value they represent. */
export type ReasoningVariants = Record<string, ReasoningVariant>;

export interface ModelsDevModel extends vscode.LanguageModelChatInformation {
  family: string;
  /** Exact API base URL from opencode's model registry (SDK Model.api.url). */
  apiUrl?: string;
  /** npm package from opencode's model registry (e.g. @ai-sdk/openai-compatible). */
  apiNpm?: string;
  reasoning?: boolean;
  /** Whether the model supports a temperature parameter. */
  temperature?: boolean;
  /**
   * Per-model reasoning variants from the opencode server (`Model.variants`).
   * Keys are the valid "Thinking Effort" choices for this model; each value
   * holds the exact AI SDK provider options to send. Absent → the model has
   * no reasoning control (no Copilot-standard fallback).
   */
  reasoningVariants?: ReasoningVariants;
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
  // Round to a whole credit — credits are displayed as integers, and the
  // raw division produces floating-point artifacts (0.154 / 0.01 →
  // 15.399999999999999) that overflow the popup UI.
  return Math.round(usd / USD_PER_CREDIT);
}

/**
 * Converts a USD-per-1M-tokens price to AI credits, but only when the value
 * is actually greater than zero. Many providers don't bill cache
 * reads/writes and report 0 — exposing 0 makes VS Code render a
 * "Cache Read: 0" / "Cache Write: 0" row in the model picker, so
 * non-positive values are surfaced as undefined (the field is omitted by
 * the UI).
 */
function positiveUsdToCredits(usd: number | undefined): number | undefined {
  const credits = usdToCredits(usd);
  return credits !== undefined && credits > 0 ? credits : undefined;
}

/** Formats a USD-per-1M-tokens price for display, e.g. "$0.14/M". */
function formatUsdPerM(usd: number | undefined): string | undefined {
  if (usd === undefined || usd === null || !Number.isFinite(usd)) {return undefined;}
  return `$${usd.toFixed(2)}/M`;
}

// ---------------------------------------------------------------------------
// SDK-TO-LOCAL TYPE MAPPERS
// ---------------------------------------------------------------------------

/** Human-readable label for a reasoning-effort value. */
function effortLabel(value: string): string {
  const labels: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max',
    xhigh: 'Extra High',
    minimal: 'Minimal',
    none: 'None',
    thinking: 'Thinking',
  };
  return labels[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/** Short description for a reasoning-effort value. */
function effortDescription(value: string): string {
  const descriptions: Record<string, string> = {
    low: 'Faster responses with less reasoning',
    medium: 'Balanced reasoning and speed',
    high: 'Greater reasoning depth but slower',
    max: 'Maximum reasoning depth, slowest responses',
    xhigh: 'Extra-high reasoning depth',
    minimal: 'Minimal reasoning, fastest responses',
    none: 'Thinking disabled',
    thinking: 'Adaptive thinking enabled',
  };
  return descriptions[value] ?? `Reasoning effort: ${value}`;
}

/**
 * Picks a safe default effort from a model's supported variants:
 * prefer `medium`, else the first non-`none` variant, else the first variant.
 */
export function defaultEffort(variants: string[]): string {
  if (variants.includes('medium')) {return 'medium';}
  const firstEnabled = variants.find((v) => v !== 'none');
  return firstEnabled ?? variants[0];
}

/**
 * Formats a token count for display, e.g. 131072 → "131K", 1000000 → "1M".
 * Values are rounded DOWN (to the nearest 1K / 0.1M) so advertised sizes
 * never overstate the true capacity — e.g. 1050000 displays as "1M",
 * matching how OpenCode's own UI presents the same limit.
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const m = Math.floor(count / 100_000) / 10;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    const k = Math.floor(count / 1_000);
    return `${k}K`;
  }
  return String(count);
}

/**
 * Extracts the model's context sizes from its cost tiers.
 *
 * opencode reports a `cost.tiers` array (not in the stale SDK `Model` type —
 * read via cast) where an entry with `tier.type === "context"` carries a
 * context-size threshold in `tier.size` (e.g. 272K for gpt-5.6-luna whose
 * full window is 1.05M). A tier marks where pricing changes, not the only
 * usable size — the model's full declared context window (`limit.context`)
 * is also valid, so it is unioned into the offered sizes.
 *
 * Context Size is ONLY advertised when the model declares context tiers —
 * no synthesized `context - output` fallback, which misrepresents models
 * (e.g. GLM-5.3-Flash) that genuinely support their full declared window.
 */
function tierContextSizes(model: Model): { sizes: number[]; default: number | undefined } {
  type ContextTier = { tier?: { type?: string; size?: number }; default?: boolean };
  const tiers = (model.cost as Record<string, unknown> | undefined)?.tiers as ContextTier[] | undefined;
  const contextSizes = (tiers ?? [])
    .filter((t) => t.tier?.type === 'context')
    .map((t) => t.tier?.size)
    .filter((n): n is number => n !== undefined && Number.isFinite(n) && n > 0);
  if (contextSizes.length === 0) {
    return { sizes: [], default: undefined };
  }
  // The full declared context window is also a usable size — include it when
  // it's larger than every tier threshold (e.g. gpt-5.6-luna: 272K tier + 1.05M).
  const fullWindow = model.limit?.context;
  if (fullWindow !== undefined && Number.isFinite(fullWindow) && fullWindow > Math.max(...contextSizes)) {
    contextSizes.push(fullWindow);
  }
  // The API marks the recommended default with `default: true` on the tier;
  // fall back to the smallest declared size.
  const defaultTier = (tiers ?? []).find(
    (t) => t.tier?.type === 'context' && t.default === true && t.tier?.size !== undefined,
  );
  const declaredDefault = defaultTier?.tier?.size ?? Math.min(...contextSizes);
  const sizes = [...new Set(contextSizes)].sort((a, b) => a - b);
  return { sizes, default: declaredDefault };
}

/**
 * Builds the VS Code `configurationSchema` for a model.
 *
 * VS Code renders two groups in the chat-input model picker:
 *   - `navigation` → "Thinking Effort" (from opencode `variants`)
 *   - `tokens`     → "Context Size" (only when the model declares context
 *                    cost tiers, with the API-marked default selected)
 * Additional enum properties (temperature, max output tokens) appear as
 * submenus in the Manage Models → Configure menu.
 *
 * The opencode server declares per-model `variants` listing the exact effort
 * values a model accepts (e.g. GLM-5.3-Flash only supports `low`/`high`/`max`).
 * We advertise exactly those values — there is no Copilot-standard fallback.
 * The default must never be `undefined` or the picker shows an "undefined" state.
 */
function buildModelConfigSchema(
  variantKeys: string[],
  contextTiers: { sizes: number[]; default: number | undefined },
  outputTokens: number | undefined,
  supportsTemperature: boolean,
): vscode.LanguageModelConfigurationSchema | undefined {
  const properties: Record<string, Record<string, unknown>> = {};

  // Thinking Effort (navigation group) — from opencode variants.
  if (variantKeys.length > 0) {
    properties.reasoningEffort = {
      type: 'string',
      title: 'Thinking Effort',
      enum: variantKeys,
      enumItemLabels: variantKeys.map(effortLabel),
      enumDescriptions: variantKeys.map(effortDescription),
      default: defaultEffort(variantKeys),
      group: 'navigation',
    };
  }

  // Context Size (tokens group) — only for models that declare context cost
  // tiers. The enum lists every declared context size, with the API-marked
  // default (`default: true` on the tier) selected. Models without tiers get
  // no Context Size option at all.
  if (contextTiers.sizes.length > 0 && contextTiers.default !== undefined) {
    properties.contextSize = {
      type: 'number',
      title: 'Context Size',
      enum: contextTiers.sizes,
      enumItemLabels: contextTiers.sizes.map(formatTokenCount),
      enumDescriptions: contextTiers.sizes.map(
        (s) => (s === contextTiers.default ? 'Default recommended context size' : `Context size (${formatTokenCount(s)})`),
      ),
      default: contextTiers.default,
      group: 'tokens',
    };
  }

  // Temperature — for models that support it.
  if (supportsTemperature) {
    properties.temperature = {
      type: 'number',
      title: 'Temperature',
      enum: [0, 0.5, 1, 1.5, 2],
      enumItemLabels: ['0', '0.5', '1', '1.5', '2'],
      enumDescriptions: ['Deterministic', 'Focused', 'Balanced', 'Creative', 'Very creative'],
      default: 1,
    };
  }

  // Max Output Tokens — from the model's output budget.
  if (outputTokens) {
    const half = Math.floor(outputTokens / 2);
    properties.maxOutputTokens = {
      type: 'number',
      title: 'Max Output Tokens',
      enum: [half, outputTokens],
      enumItemLabels: [formatTokenCount(half), formatTokenCount(outputTokens)],
      enumDescriptions: ['Half the model maximum', 'Full model maximum'],
      default: outputTokens,
    };
  }

  return Object.keys(properties).length > 0 ? { properties } : undefined;
}

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

  // The SDK's Model type is stale: the live server also returns `variants`
  // (per-model reasoning effort choices) and `capabilities.interleaved`.
  const variants = (model as { variants?: ReasoningVariants }).variants;
  const hasDeclaredVariants = !!variants && Object.keys(variants).length > 0;

  // Build the model configuration schema: Thinking Effort (from variants),
  // Context Size (only when context cost tiers are declared), Temperature,
  // and Max Output Tokens. VS Code renders the navigation/tokens groups in
  // the chat-input model picker; other enum properties appear in
  // Manage Models → Configure.
  const configurationSchema = buildModelConfigSchema(
    hasDeclaredVariants ? Object.keys(variants) : [],
    tierContextSizes(model),
    model.limit?.output,
    model.capabilities.temperature,
  );

  return {
    id: `${model.providerID}/${model.id}`,
    name: `${sp.name} - ${model.name}`,
    // Copilot gates PDF attachments on isAnthropicFamily(model) —
    // family.startsWith('claude') || family.startsWith('Anthropic') — and
    // otherwise renders the PDF as an omitted reference WITHOUT ever sending
    // the bytes to the provider. Models routed via @ai-sdk/anthropic must
    // therefore report the Anthropic family (matching upstream's own Anthropic
    // BYOK provider, which also uses family 'Anthropic'). Routing no longer
    // depends on family: it derives the provider id from the model id prefix.
    family: model.api?.npm === '@ai-sdk/anthropic' ? 'Anthropic' : model.providerID,
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
    configurationSchema,
    reasoningVariants: hasDeclaredVariants ? variants : undefined,
    temperature: model.capabilities.temperature,
    version: "1.0.0",
    pricing: pricingParts.length > 0 ? pricingParts.join(' · ') : undefined,
    // cache-read prices go through positiveUsdToCredits too: several
    // providers report 0 for cache reads (no cache configured / free cache),
    // and exposing 0 makes VS Code render a "Cache Read: 0" row in the
    // model picker.
    cacheCost: positiveUsdToCredits(cacheReadUsd),
    cacheWriteCost: positiveUsdToCredits(cacheWriteUsd),
    inputCost: usdToCredits(inputUsd),
    outputCost: usdToCredits(outputUsd),
    longContextCacheCost: positiveUsdToCredits(longCacheReadUsd),
    longContextCacheWriteCost: positiveUsdToCredits(longCacheWriteUsd),
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
