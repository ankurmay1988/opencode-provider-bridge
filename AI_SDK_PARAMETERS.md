# AI SDK Model Parameters Reference

Catalog of every model parameter supported by the installed `@ai-sdk/**` packages,
for integrating model configuration (reasoning effort, thinking, temperature, etc.)
into the OpenCode Provider Bridge.

Installed packages: `@ai-sdk/provider`, `@ai-sdk/openai`,
`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google`,
`@ai-sdk/gateway`, `@ai-sdk/provider-utils`, plus the `ai` core.

---

## 1. Standardized parameters — `@ai-sdk/provider`

Every provider supports these via `LanguageModelV3CallOptions` (the `ai` core maps
top-level `streamText` options onto them):

| Parameter | Type | Notes |
|---|---|---|
| `maxOutputTokens` | `number` | Max tokens to generate |
| `temperature` | `number` | Range depends on provider/model |
| `topP` | `number` | Nucleus sampling (0–1) |
| `topK` | `number` | Top-K sampling |
| `presencePenalty` | `number` | −1..1 |
| `frequencyPenalty` | `number` | −1..1 |
| `stopSequences` | `string[]` | Stop generation on these |
| `seed` | `number` | Deterministic sampling |
| `responseFormat` | `{type:'text'} \| {type:'json', schema?, name?, description?}` | JSON mode |
| `tools` | `LanguageModelV3FunctionTool[]` | Tool definitions |
| `toolChoice` | `'auto' \| 'none' \| 'required' \| {type:'tool', toolName}` | Tool selection |
| `includeRawChunks` | `boolean` | Include raw stream chunks |
| `abortSignal` | `AbortSignal` | Cancellation |
| `headers` | `Record<string,string>` | Extra HTTP headers |
| `providerOptions` | `SharedV3ProviderOptions` | Provider-specific (below) |

---

## 2. `@ai-sdk/openai-compatible` — `providerOptions.openaiCompatible`

| Option | Type | Wire field |
|---|---|---|
| `user` | `string` | `user` |
| `reasoningEffort` | `string` | `reasoning_effort` |
| `textVerbosity` | `string` | `verbosity` |
| `strictJsonSchema` | `boolean` | (structured output) |

---

## 2b. `@ai-sdk/openai` — `providerOptions.openai`

| Option | Type | Wire field |
|---|---|---|
| `reasoningEffort` | `'none' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | `reasoning_effort` (chat) / `reasoning.effort` (responses) |
| `reasoningSummary` | `string` | `reasoning.summary` (responses) |
| `maxCompletionTokens` | `number` | `max_completion_tokens` |
| `store` | `boolean` | `store` |
| `metadata` | `Record<string,string>` | `metadata` |
| `user` | `string` | `user` |
| `parallelToolCalls` | `boolean` | `parallel_tool_calls` |
| `logitBias` | `Record<string,number>` | `logit_bias` |
| `logprobs` | `boolean \| number` | `logprobs` / `top_logprobs` |
| `textVerbosity` | `string` | `verbosity` |

Note: `@ai-sdk/openai` uses a strict zod schema — unknown provider options are
**dropped**, not spread into the body (unlike `@ai-sdk/openai-compatible`).

---

## 3. `@ai-sdk/anthropic` — `providerOptions.anthropic`

| Option | Type | Notes |
|---|---|---|
| `sendReasoning` | `boolean` | Include reasoning in response |
| `structuredOutputMode` | `'outputFormat' \| 'jsonTool' \| 'auto'` | |
| `thinking` | `{type:'adaptive', display?} \| {type:'enabled', budgetTokens?} \| {type:'disabled'}` | Thinking control |
| `disableParallelToolUse` | `boolean` | |
| `cacheControl` | `{type:'ephemeral', ttl?: '5m'\|'1h'}` | Prompt caching |
| `metadata.userId` | `string` | |
| `mcpServers` | `{type:'url', name, url, authorizationToken?, toolConfiguration?}[]` | MCP servers |
| `container` | `{id?, skills?}` | Container skills |
| `toolStreaming` | `boolean` | |
| **`effort`** | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | **Reasoning effort** |
| `taskBudget` | `{type:'tokens', total, remaining?}` | |
| `speed` | `'fast' \| 'standard'` | |
| `inferenceGeo` | `'us' \| 'global'` | |
| `anthropicBeta` | `string[]` | Beta headers |
| `contextManagement` | `{edits: [...]}` | Context compaction |

---

## 4. `@ai-sdk/google` — `providerOptions.google`

| Option | Type | Notes |
|---|---|---|
| `responseModalities` | `('TEXT'\|'IMAGE')[]` | |
| **`thinkingConfig`** | `{thinkingBudget?, includeThoughts?, thinkingLevel?: 'minimal'\|'low'\|'medium'\|'high'}` | **Thinking / effort** |
| `cachedContent` | `string` | |
| `structuredOutputs` | `boolean` | |
| `safetySettings` | `{category, threshold}[]` | |
| `threshold` | `'BLOCK_*' \| 'OFF'` | |
| `audioTimestamp` | `boolean` | |
| `labels` | `Record<string,string>` | |
| `mediaResolution` | `'LOW'\|'MEDIUM'\|'HIGH'` | |
| `imageConfig` | `{aspectRatio?, imageSize?}` | |
| `retrievalConfig` | `{latLng?}` | |
| `streamFunctionCallArguments` | `boolean` | |
| `serviceTier` | `'standard' \| 'flex' \| 'priority'` | |

---

## 5. `@ai-sdk/gateway` — `providerOptions.gateway`

| Option | Type | Notes |
|---|---|---|
| `only` | `string[]` | Restrict providers |
| `order` | `string[]` | Provider order |
| `sort` | `'cost' \| 'ttft' \| 'tps'` | Routing sort |
| `user` | `string` | |
| `tags` | `string[]` | |
| `models` | `string[]` | |
| `byok` | `Record<string, Record<string, unknown>[]>` | |
| `zeroDataRetention` | `boolean` | |
| `disallowPromptTraining` | `boolean` | |
| `hipaaCompliant` | `boolean` | |
| `quotaEntityId` | `string` | |
| `providerTimeouts` | `{byok?: Record<string, number>}` | |

---

## 6. `ai` core — top-level `streamText` / `CallSettings`

| Parameter | Type |
|---|---|
| `maxOutputTokens` | `number` |
| `temperature` | `number` |
| `topP` | `number` |
| `topK` | `number` |
| `presencePenalty` | `number` |
| `frequencyPenalty` | `number` |
| `stopSequences` | `string[]` |
| `seed` | `number` |
| `maxRetries` | `number` (default 2) |
| `abortSignal` | `AbortSignal` |
| `timeout` | `number \| {totalMs?, stepMs?, chunkMs?}` |
| `headers` | `Record<string,string>` |
| `responseFormat` | text / json |
| `tools` / `toolChoice` | tool set + selection |
| `providerOptions` | per-call provider options |

---

## Integration mapping — model configuration across providers

The opencode server returns per-model `variants` whose keys are the exact
"Thinking Effort" choices a model accepts (e.g. GLM-5.3-Flash = `low`/`high`/`max`;
kimi-k3 = `max`; gemini = `minimal`/`low`/`medium`/`high`). Each variant value is
already in the AI SDK provider-option shape, so the extension spreads it 1:1:

| Variant value shape | SDK providerOptions |
|---|---|
| `{ reasoningEffort: "low" }` | `openaiCompatible.reasoningEffort` → `reasoning_effort` |
| `{ reasoningEffort: "low", reasoningSummary: "auto", include: [...] }` (apiNpm `@ai-sdk/openai`) | `openai.reasoningEffort` → `reasoning_effort`; `reasoningSummary`/`include` handled by the SDK (responses) |
| `{ reasoningEffort: "low", reasoningSummary: "auto", include: [...] }` (apiNpm `@ai-sdk/openai-compatible`) | `openaiCompatible` (extra keys spread into body) |
| `{ thinkingConfig: { includeThoughts, thinkingLevel } }` | `google.thinkingConfig` |
| `{ thinking: { type: "adaptive", display: "summarized" }, effort: "high" }` | `anthropic.thinking` + `anthropic.effort` |
| `{ thinking: { type: "enabled", budgetTokens } }` | `anthropic.thinking` |
| `{ thinking: { type: "disabled" } }` | `openaiCompatible` (spread into body) |

Additional controls: `contextSize` (tokens group, forwarded as
`openaiCompatible.contextSize` when smaller than full; skipped for
anthropic/google/openai), `temperature` and `maxOutputTokens` (top-level
`streamText` options).