import * as vscode from 'vscode';

import type { ModelMessage, ToolSet } from 'ai';
import { defaultEffort, ModelsDevModel, ModelsDevProvider, type ReasoningVariant } from './opencodeConfig.js';
import { extractTextFromToolResult, simplifySchema } from './providerUtils.js';
import { jsonSchema, streamText, tool } from 'ai';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createVerboseFetch } from './verboseFetch.js';
import { log } from './logger.js';
import {
  ensureZenReasoningContent,
  extractZenReasoning,
  isDeepSeekModel,
  withThinkingMetadata,
  type ZenReasoningHistoryPart,
} from './zenReasoning.js';

const VERBOSE_FETCH = createVerboseFetch(globalThis.fetch);

/**
 * Normalizes a tool-call input to a JSON object.
 *
 * The AI SDK's OpenAI-compatible serializer emits `function.arguments` as
 * `JSON.stringify(input)`. The opencode server requires that value to be a
 * JSON object, so a string (or any other primitive) input would be serialized
 * as a JSON string/primitive and rejected with a 400 error:
 *   "Assistant tool call function.arguments must be a JSON object."
 *
 * VS Code can hand us a non-object input (e.g. the model returned a
 * JSON-string literal for `arguments`, or history replay provides a string),
 * so we coerce it here:
 *   - plain object        → used as-is
 *   - JSON string that    → parsed (when it yields a plain object)
 *     parses to an object
 *   - anything else       → wrapped as { value: <input> }
 */
function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) {
    return {};
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON — fall through to wrapping.
    }
  }
  return { value: input };
}

export class OpencodeModelProvider
  implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  lastUsage: { prompt: number; completion: number } | null = null;

  /** OpenAI SDK provider instance (for models with api.npm = "@ai-sdk/openai"). */
  private openaiProvider: ReturnType<typeof createOpenAI> | null = null;

  /** OpenAI-compatible provider instance (for models with api.npm = "@ai-sdk/openai-compatible"). */
  private openaiCompatibleProvider: ReturnType<typeof createOpenAICompatible> | null = null;

  /** Anthropic provider instance (for models returning Anthropic SSE, e.g. Qwen). */
  private anthropicProvider: ReturnType<typeof createAnthropic> | null = null;

  /** Google Generative AI provider instance (for Gemini models). */
  private googleProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;

  /** Cache of simplified tool input schemas keyed by tool name. */
  private toolSchemaCache = new Map<string, Record<string, unknown>>();

  /**
   * Cross-turn cache mapping toolCallId → toolName.
   * Populated when processing assistant tool-call parts so that when a
   * subsequent tool-result part arrives (which lacks a name property in
   * VS Code's LanguageModelToolResultPart), we can still report the
   * correct tool name to the AI SDK.
   */
  private toolCallNameCache = new Map<string, string>();

  constructor(
    readonly providerInfo: ModelsDevProvider,
    private apiKey: string,
    private enabledModels: Map<string, ModelsDevModel>,
  ) {}

  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    this.openaiProvider = null;
    this.openaiCompatibleProvider = null;
    this.anthropicProvider = null;
    this.googleProvider = null;
  }

  fireChange(): void {
    this.onDidChangeEmitter.fire();
  }

  /** Base URL for this provider's API. */
  private getBaseUrl(): string {
    const knownApis: Record<string, string> = {
      opencode: 'https://opencode.ai/zen/v1',
      'opencode-go': 'https://opencode.ai/go/v1',
    };
    return this.providerInfo.api || knownApis[this.providerInfo.id] || `https://api.${this.providerInfo.id}.com/v1`;
  }

  /**
   * Returns the correct LanguageModelV3 for a given model, routing to
   * the appropriate AI SDK based on the model's `apiNpm` metadata from
   * the opencode provider registry.
   *
   * The opencode SDK returns per-model metadata that tells us exactly
   * which AI SDK package to use (e.g. `@ai-sdk/openai`,
   * `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google`).
   * This is the authoritative source of truth:
   *
   *   @ai-sdk/openai             → sends OpenAI-format requests
   *                                 to /v1/chat/completions
   *   @ai-sdk/openai-compatible  → sends OpenAI-format requests
   *                                 to /v1/chat/completions
   *   @ai-sdk/anthropic          → sends Anthropic-format requests
   *                                 to /v1/messages
   *   @ai-sdk/google             → sends Google Generative AI requests
   *                                 to /v1/models/{model}
   *
   * The per-model apiUrl (if set) is used as the base URL for the
   * provider (except for Google models, where the provider-level
   * URL is used since the SDK constructs the model path internally).
   * When it's not set (fallback tiers), `getBaseUrl()` is used instead.
   */
  private getLanguageModel(modelId: string) {
    const modelMeta = this.enabledModels.get(modelId);
    const apiUrl = modelMeta?.apiUrl ?? '';
    const apiNpm = modelMeta?.apiNpm ?? '';

    // ── Verbose routing diagnostics ────────────────────────────────
    log(`[opencode-provider-bridge] ROUTE model="${modelId}" apiUrl="${apiUrl}" apiNpm="${apiNpm}" provider="${this.providerInfo.id}"`, 'debug');
    log(`[opencode-provider-bridge] ROUTE modelMeta: ${JSON.stringify({
      id: modelMeta?.id,
      name: modelMeta?.name,
      family: modelMeta?.family,
      apiUrl: modelMeta?.apiUrl,
      apiNpm: modelMeta?.apiNpm,
    }, null, 2)}`, 'debug');

    // Use per-model apiUrl if available, otherwise fall back to provider-level URL
    const baseUrl = (apiUrl || this.getBaseUrl()).replace(/\/$/, '');

    if (apiNpm === '@ai-sdk/google') {
      // Google SDK constructs URLs like:
      //   {baseURL}/models/{modelId}:streamGenerateContent?alt=sse
      // The per-model apiUrl already includes the model-specific path
      // (e.g. /zen/v1/models/gemini-3.1-pro), so we use the provider-level
      // base URL and let the SDK append the model path.
      const googleBaseUrl = this.getBaseUrl().replace(/\/$/, '');
      log(`[opencode-provider-bridge] ROUTE → Google SDK (@ ${googleBaseUrl})`, 'debug');
      if (!this.googleProvider) {
        this.googleProvider = createGoogleGenerativeAI({
          name: this.providerInfo.id,
          baseURL: googleBaseUrl,
          apiKey: this.apiKey,
          fetch: VERBOSE_FETCH,
        });
      }
      return this.googleProvider(modelId);
    }

    if (apiNpm === '@ai-sdk/anthropic' || apiUrl.includes('/messages')) {
      log(`[opencode-provider-bridge] ROUTE → Anthropic SDK (@ ${baseUrl})`, 'debug');
      if (!this.anthropicProvider) {
        this.anthropicProvider = createAnthropic({
          name: this.providerInfo.id,
          baseURL: baseUrl,
          apiKey: this.apiKey,
          fetch: VERBOSE_FETCH,
        });
      }
      return this.anthropicProvider(modelId);
    }

    if (apiNpm === '@ai-sdk/openai') {
      // Real OpenAI SDK — required for OpenAI-native models (e.g. gpt-5.6-luna).
      // openai-compatible hits the same URL but the Zen API rejects its request
      // shape with a 500, so these models MUST use @ai-sdk/openai.
      log(`[opencode-provider-bridge] ROUTE → OpenAI SDK (@ ${baseUrl})`, 'debug');
      if (!this.openaiProvider) {
        this.openaiProvider = createOpenAI({
          name: this.providerInfo.id,
          baseURL: baseUrl,
          apiKey: this.apiKey,
          fetch: VERBOSE_FETCH,
        });
      }
      return this.openaiProvider(modelId);
    }

    // Default: OpenAI-compatible (for @ai-sdk/openai-compatible or when apiNpm is unknown)
    log(`[opencode-provider-bridge] ROUTE → OpenAI-compatible SDK (@ ${baseUrl})`, 'debug');
    if (!this.openaiCompatibleProvider) {
      this.openaiCompatibleProvider = createOpenAICompatible({
        name: this.providerInfo.id,
        baseURL: baseUrl,
        apiKey: this.apiKey,
        fetch: VERBOSE_FETCH,
      });
    }
    return this.openaiCompatibleProvider(modelId);
  }

  /**
   * Maps the user's reasoning-effort selection (from the model picker's
   * "Thinking Effort" control) to the provider-specific AI SDK option.
   *
   * The value arrives via `options.modelConfiguration.reasoningEffort` and is
   * forwarded as call-level `providerOptions` to `streamText`. Each SDK uses a
   * different key:
   *   - @ai-sdk/openai            → `openai` (variant spread 1:1)
   *   - @ai-sdk/openai-compatible → `openaiCompatible` (variant spread 1:1)
   *   - @ai-sdk/anthropic         → `anthropic` (variant spread 1:1)
   *   - @ai-sdk/google            → `google` (variant spread 1:1)
   *
   * When the model declares `variants`, only those exact effort values are
   * valid; an out-of-range selection (e.g. a stale "medium" from a previous
   * session) is coerced to a valid default. Returns undefined when no effort
   * is configured, the model doesn't support reasoning, or the model declares
   * no variants (no Copilot-standard fallback).
   */
  private buildReasoningProviderOptions(
    modelId: string,
    reasoningEffort: string | undefined,
  ) {
    if (!reasoningEffort) {return undefined;}
    const modelMeta = this.enabledModels.get(modelId);
    if (modelMeta?.reasoning !== true) {return undefined;}

    // Only models that declare opencode `variants` get reasoning options.
    // No Copilot-standard low/medium/high fallback: if opencode doesn't
    // declare variants, we don't send any reasoning parameter.
    const variants = modelMeta?.reasoningVariants;
    if (!variants || Object.keys(variants).length === 0) {
      return undefined;
    }

    const keys = Object.keys(variants);
    const valid = keys.includes(reasoningEffort) ? reasoningEffort : defaultEffort(keys);
    if (valid !== reasoningEffort) {
      log(`[opencode-provider-bridge] MODEL_CONFIG reasoningEffort="${reasoningEffort}" not supported by ${modelId} (${keys.join('/')}); using "${valid}"`, 'warn');
    }

    return this.reasoningOptionsFor(modelMeta.apiNpm ?? '', variants[valid]);
  }

  /**
   * Passes an opencode reasoning variant through to the model's AI SDK as
   * provider options. opencode's variant values are already in the exact
   * shape of the AI SDK provider options (opencode uses the same SDKs
   * internally), so no translation is needed — we spread them 1:1.
   */
  private reasoningOptionsFor(apiNpm: string, variant: ReasoningVariant) {
    if (apiNpm === '@ai-sdk/anthropic') {
      return { anthropic: { ...variant } };
    }
    if (apiNpm === '@ai-sdk/google') {
      return { google: { ...variant } };
    }
    if (apiNpm === '@ai-sdk/openai') {
      // Real OpenAI SDK: `reasoningEffort` maps to reasoning_effort; the SDK
      // handles reasoningSummary/include for the responses API and drops
      // unknown keys for the chat API (matching opencode's own behavior).
      return { openai: { ...variant } };
    }
    // Default: OpenAI-compatible (also covers unknown apiNpm). Unknown keys
    // (e.g. `thinking`) are spread into the request body by the SDK.
    return { openaiCompatible: { ...variant } };
  }

  /**
   * Builds the call-level `providerOptions` for a request from the user's
   * model configuration: reasoning variants plus (best-effort) context size.
   *
   * The context size is forwarded as a provider option only when the user
   * explicitly picks a smaller-than-full window (the default full window is
   * the model's native behavior and needs no request param). openai-compatible
   * spreads unknown keys into the request body, so it reaches the upstream if
   * supported; anthropic/google/openai use strict schemas with no clean
   * context-size param, so it is skipped there.
   */
  private buildProviderOptions(
    modelId: string,
    reasoningEffort: string | undefined,
    contextSize: number | undefined,
  ) {
    const options: Record<string, any> = this.buildReasoningProviderOptions(modelId, reasoningEffort) ?? {};

    if (contextSize !== undefined && Number.isFinite(contextSize) && contextSize > 0) {
      const modelMeta = this.enabledModels.get(modelId);
      const apiNpm = modelMeta?.apiNpm ?? '';
      const fullContext = modelMeta?.maxInputTokens;
      if (fullContext !== undefined && contextSize >= fullContext) {
        log(`[opencode-provider-bridge] MODEL_CONFIG contextSize=${contextSize} is the full window; not forwarding`, 'debug');
      } else if (apiNpm === '@ai-sdk/anthropic' || apiNpm === '@ai-sdk/google' || apiNpm === '@ai-sdk/openai') {
        log(`[opencode-provider-bridge] MODEL_CONFIG contextSize=${contextSize} not supported by ${apiNpm}; skipping`, 'warn');
      } else {
        options.openaiCompatible = { ...(options.openaiCompatible ?? {}), contextSize };
      }
    }

    return Object.keys(options).length > 0 ? options : undefined;
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const [modelId, modelMeta] of this.enabledModels) {
      log(`[opencode-provider-bridge] REGISTER model="${modelId}" name="${modelMeta.name ?? modelId}" apiUrl="${modelMeta.apiUrl ?? '(none)'}" apiNpm="${modelMeta.apiNpm ?? '(none)'}" tool_call=${modelMeta.capabilities?.toolCalling ?? false} reasoning=${modelMeta.reasoning ?? false} ctx=${modelMeta.maxInputTokens ?? '?'}`, 'debug');

      models.push(modelMeta);
    }

    log(`[opencode-provider-bridge] Registered ${models.length} models for provider "${this.providerInfo.name}"`, 'info');
    return models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let currentReasoning = '';
    let reasoningEnded = false;

    const modelMeta = this.enabledModels.get(model.id);
    // User's model configuration from the model picker (if any).
    const reasoningEffort = options.modelConfiguration?.reasoningEffort as string | undefined;
    const temperature = options.modelConfiguration?.temperature as number | undefined;
    const maxOutputTokens = options.modelConfiguration?.maxOutputTokens as number | undefined;
    const contextSize = options.modelConfiguration?.contextSize as number | undefined;
    if (reasoningEffort) {
      log(`[opencode-provider-bridge] MODEL_CONFIG reasoningEffort="${reasoningEffort}" model=${model.id}`, 'debug');
    }
    if (temperature !== undefined) {
      log(`[opencode-provider-bridge] MODEL_CONFIG temperature=${temperature} model=${model.id}`, 'debug');
    }
    if (maxOutputTokens !== undefined) {
      log(`[opencode-provider-bridge] MODEL_CONFIG maxOutputTokens=${maxOutputTokens} model=${model.id}`, 'debug');
    }
    if (contextSize !== undefined) {
      log(`[opencode-provider-bridge] MODEL_CONFIG contextSize=${contextSize} model=${model.id}`, 'debug');
    }
    // DeepSeek thinking APIs require reasoning_content on every replayed
    // assistant message (including VS Code's synthetic tool-call history).
    // Only DeepSeek models are affected: Anthropic, Gemini, GPT, Grok,
    // Kimi, GLM, Qwen, ... do not share that requirement, so the empty
    // field is injected exclusively for DeepSeek reasoning models.
    const deepSeekModel = isDeepSeekModel({
      providerId: this.providerInfo.id,
      modelId: model.id,
      family: modelMeta?.family,
      name: modelMeta?.name,
    });
    const ensureReasoningField = modelMeta?.reasoning === true && deepSeekModel;
    const coreMessages = ensureZenReasoningContent(
      this.toModelMessages(messages),
      ensureReasoningField,
    );
    log(`[opencode-provider-bridge] Converted ${coreMessages.length} messages for model=${model.id}`, 'debug');
    log(`[opencode-provider-bridge] MESSAGE DIAGNOSTICS ${JSON.stringify(coreMessages.map((message) => {
      const content = Array.isArray(message.content) ? message.content : [];
      const reasoning = content.filter((part: any) => part.type === 'reasoning');
      return {
        role: message.role,
        parts: Array.isArray(message.content) ? content.length : 1,
        reasoning: reasoning.length > 0,
        reasoningLength: reasoning.reduce((length: number, part: any) => length + part.text.length, 0),
        toolCalls: content.filter((part: any) => part.type === 'tool-call').length,
      };
    }))}`, 'debug');

    const tools: ToolSet = {};
    if (options.tools?.length) {
      log(`[opencode-provider-bridge] Building ${options.tools.length} tool(s)`, 'debug');
      for (const t of options.tools) {
        let params = this.toolSchemaCache.get(t.name);
        if (!params) {
          params = simplifySchema(t.inputSchema, t.name);
          this.toolSchemaCache.set(t.name, params);
          log(`[opencode-provider-bridge] Tool: ${t.name} simplified`, 'debug');
        }

        tools[t.name] = tool({
          description: t.description ?? '',
          inputSchema: jsonSchema(params),
        });
      }
    }

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    const toolChoice = options.toolMode === vscode.LanguageModelChatToolMode.Required
      ? 'required'
      : 'auto';

    const languageModel = this.getLanguageModel(model.id);
    const providerOptions = this.buildProviderOptions(model.id, reasoningEffort, contextSize);

    log(`[opencode-provider-bridge] Calling streamText model=${model.id} tools=${Object.keys(tools).length}`, 'info');

    // Progress type assertion: LanguageModelThinkingPart is available in the
    // VS Code 1.120+ runtime even if @types/vscode doesn't include it in
    // LanguageModelResponsePart yet.
    const report = progress.report.bind(progress) as (part: unknown) => void;

    try {
      const result = streamText({
        model: languageModel,
        messages: coreMessages as any,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        toolChoice: Object.keys(tools).length > 0 ? toolChoice : undefined,
        abortSignal: abortController.signal,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        // Values are JSON-serializable (strings + nested objects); the cast
        // satisfies SharedV3ProviderOptions' JSONObject index signature.
        ...(providerOptions ? { providerOptions: providerOptions as any } : {}),
      });

      let hasText = false;
      let hasToolCall = false;

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            hasText = true;
            report(new vscode.LanguageModelTextPart(part.text));
            break;

          case 'reasoning-delta':
            currentReasoning += part.text;
            // Report each reasoning chunk immediately so VS Code's UI
            // shows thinking/reasoning content in real-time.
            report(new vscode.LanguageModelThinkingPart(part.text));
            break;

          case 'reasoning-start':
            // Signal VS Code that reasoning/thinking has started.
            // This triggers the thinking animation in the chat response.
            report(new vscode.LanguageModelThinkingPart(''));
            break;

          case 'reasoning-end':
            reasoningEnded = true;
            // Signal VS Code that reasoning is complete.
            // This closes the thinking animation in the chat response.
            {
              report(withThinkingMetadata(
                new vscode.LanguageModelThinkingPart(''),
                { vscode_reasoning_done: true },
              ));
            }
            break;

          case 'tool-call':
            hasToolCall = true;
            log(`[opencode-provider-bridge] TOOL_OUT: ${part.toolName} id=${part.toolCallId}`, 'debug');
            report(new vscode.LanguageModelToolCallPart(
              part.toolCallId,
              part.toolName,
              normalizeToolInput(part.input),
            ));
            break;

          case 'tool-result':
            // Render tool execution result in the chat UI so the user can see
            // what the tool returned between the model's response.
            if (part.output) {
              const resultText = extractTextFromToolResult(part.output);
              if (resultText) {
                report(new vscode.LanguageModelToolResultPart(
                  part.toolCallId,
                  [new vscode.LanguageModelTextPart(resultText)],
                ));
              }
            }
            break;

          case 'finish': {
            const { totalUsage } = part;
            if (totalUsage) {
              this.lastUsage = {
                prompt: totalUsage.inputTokens ?? 0,
                completion: totalUsage.outputTokens ?? 0,
              };
            }
            break;
          }

          case 'error':
            log(`[opencode-provider-bridge] Stream error: ${part.error}`, 'error');
            throw part.error instanceof Error
              ? part.error
              : new Error(String(part.error));
        }
      }

      // VS Code persists completed thinking from this metadata. Streaming
      // thinking deltas render in the UI but are not sufficient for history.
      // Do not replace this marker with a DataPart: custom DataParts are not
      // returned in later LanguageModelChatRequestMessage history.
      if (currentReasoning) {
        log(`[opencode-provider-bridge] REASONING_OUT source=SSE length=${currentReasoning.length} ended=${reasoningEnded}`, 'debug');
        report(withThinkingMetadata(
          new vscode.LanguageModelThinkingPart(''),
          {
            _completeThinking: currentReasoning,
            ...(reasoningEnded ? {} : { vscode_reasoning_done: true }),
          },
        ));
      }

      if (this.lastUsage) {
        report(new vscode.LanguageModelDataPart(
          new TextEncoder().encode(JSON.stringify({
            prompt_tokens: this.lastUsage.prompt,
            completion_tokens: this.lastUsage.completion,
            total_tokens: this.lastUsage.prompt + this.lastUsage.completion,
          })),
          'usage',
        ));
      }

      if (!hasText && !hasToolCall && !currentReasoning) {
        log(`[opencode-provider-bridge] Empty response — reporting minimal text to prevent Copilot Unknown error`, 'warn');
        report(new vscode.LanguageModelTextPart(''));
      }
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {throw err;}

      // Classify common error types
      const message = (err as Error).message?.toLowerCase() ?? '';
      const statusCode = (err as any).status ?? (err as any).statusCode ?? 0;

      if (statusCode === 429 || message.includes('rate limit') || message.includes('too many')) {
        throw vscode.LanguageModelError.Blocked(
          `${this.providerInfo.name}: rate limited. Please wait and try again.`,
        );
      }
      if (statusCode === 401 || statusCode === 403 || message.includes('unauthorized') || message.includes('invalid api key')) {
        throw vscode.LanguageModelError.NotFound(
          `${this.providerInfo.name}: invalid API key. Use "OpenCode Bridge: Set API Key" to update it.`,
        );
      }
      if (statusCode === 402 || message.includes('quota') || message.includes('insufficient_quota')) {
        throw new vscode.LanguageModelError(
          `${this.providerInfo.name}: quota exceeded. Please check your plan and billing.`,
        );
      }

      throw new vscode.LanguageModelError(
        `${this.providerInfo.name} request failed: ${(err as Error).message}`,
      );
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const serialized = typeof text === 'string' ? text : JSON.stringify(text.content);
    return Math.max(1, Math.ceil(serialized.length / 4));
  }

  private toModelMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): ModelMessage[] {
    const result: ModelMessage[] = [];
    const SystemRole = (vscode.LanguageModelChatMessageRole as any).System;

    for (const msg of messages) {
      const textParts: string[] = [];
      const toolCallParts: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }> = [];
      let toolCallId: string | undefined;
      let toolResultContent: string | undefined;
      let toolResultName: string | undefined;
      const reasoningParts: ZenReasoningHistoryPart[] = [];

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          log(`[opencode-provider-bridge] convert: ToolCall name=${part.name} id=${part.callId}`, 'debug');
          // Cache the name so subsequent ToolResultPart conversions can look it up.
          this.toolCallNameCache.set(part.callId, part.name);
          toolCallParts.push({
            toolCallId: part.callId,
            toolName: part.name,
            input: normalizeToolInput(part.input),
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          log(`[opencode-provider-bridge] convert: ToolResult id=${part.callId}`, 'debug');
          toolCallId = part.callId;
          // LanguageModelToolResultPart has no `.name` property in VS Code's
          // API. Look up the tool name from the cache (populated when the
          // preceding assistant message's tool-call was processed). Fall
          // back to 'unknown' for debugging visibility.
          toolResultName = this.toolCallNameCache.get(part.callId) ?? (part as any).name ?? undefined;
          log(`[opencode-provider-bridge] convert: ToolResult id=${part.callId} resolvedName="${toolResultName ?? '(still undefined)'}"`, 'debug');
          const isStringContent = typeof (part as any).content === 'string';
          toolResultContent = isStringContent
            ? (part as any).content as string
            : (part.content as Array<unknown>)
                .filter((c): c is vscode.LanguageModelTextPart =>
                  c instanceof vscode.LanguageModelTextPart,
                )
                .map((c) => c.value)
                .join('\n');
        } else if (part instanceof vscode.LanguageModelDataPart) {
          reasoningParts.push({
            kind: 'data',
            mimeType: part.mimeType,
            data: part.data,
          });
        } else if (part instanceof vscode.LanguageModelThinkingPart) {
          reasoningParts.push({
            kind: 'thinking',
            value: part.value ?? '',
            metadata: part.metadata,
          });
        }
      }

      const reasoningContent = extractZenReasoning(reasoningParts);
      if (reasoningParts.length > 0) {
        log(`[opencode-provider-bridge] REASONING_HISTORY role=${msg.role} parts=${reasoningParts.length} restored=${reasoningContent.length > 0} length=${reasoningContent.length}`, 'debug');
      }

      if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') });
        }
        if (toolCallId && toolResultContent !== undefined) {
          const resolvedName = toolResultName ?? 'unknown';
          if (resolvedName === 'unknown') {
            log(`[opencode-provider-bridge] WARNING: toolName for callId=${toolCallId} is still 'unknown' — cache miss`, 'warn');
          }
          result.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId,
                toolName: resolvedName,
                output: { type: 'text', value: toolResultContent },
              },
            ],
          });
        }
      } else if (SystemRole !== undefined && msg.role === SystemRole) {
        const text = textParts.join('\n');
        if (text) {
          result.push({ role: 'system', content: text });
        }
      } else {
        const text = textParts.join('\n');
        const contentParts: Array<Record<string, unknown>> = [];

        if (text) {
          contentParts.push({ type: 'text', text });
        }
        for (const tc of toolCallParts) {
          contentParts.push({ type: 'tool-call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input });
        }
        if (reasoningContent) {
          contentParts.push({ type: 'reasoning', text: reasoningContent });
        }

        result.push({
          role: 'assistant',
          content: contentParts.length > 0 ? contentParts : text,
        } as ModelMessage);
      }
    }

    return result;
  }
}
