# OpenCode BYOK Implementation — Deep Analysis & Architecture Guide

> **Based on:** VS Code Copilot BYOK provider implementations  
> **Source repo:** https://github.com/microsoft/vscode/tree/main/extensions/copilot/src/extension/byok  
> **Analysis Date:** May 14, 2026

---

## Table of Contents

1. [BYOK Provider Landscape](#1-byok-provider-landscape)
2. [Architecture Overview](#2-architecture-overview)
3. [Class Hierarchy & Provider Patterns](#3-class-hierarchy--provider-patterns)
4. [Provider-by-Provider Deep Analysis](#4-provider-by-provider-deep-analysis)
5. [Shared Infrastructure](#5-shared-infrastructure)
6. [Message Conversion Patterns](#6-message-conversion-patterns)
7. [Telemetry & Observability Layer](#7-telemetry--observability-layer)
8. [API Key Storage & Management](#8-api-key-storage--management)
9. [Contribution & Registration Flow](#9-contribution--registration-flow)
10. [OpenCode BYOK Implementation Blueprint](#10-opencode-byok-implementation-blueprint)

---

## 1. BYOK Provider Landscape

### 1.1 All Providers in VS Code Copilot

| Provider | Class | Extends | Protocol | Key Type | File |
|----------|-------|---------|----------|----------|------|
| **Anthropic** | `AnthropicLMProvider` | `AbstractLanguageModelChatProvider` | Anthropic Messages API (native) | `apiKey` | `anthropicProvider.ts` |
| **Gemini** | `GeminiNativeBYOKLMProvider` | `AbstractLanguageModelChatProvider` | Gemini API (native SDK) | `apiKey` | `geminiNativeProvider.ts` |
| **OpenAI** | `OAIBYOKLMProvider` | `AbstractOpenAICompatibleLMProvider` | OpenAI Chat Completions + Responses | `apiKey` | `openAIProvider.ts` |
| **xAI** | `XAIBYOKLMProvider` | `AbstractOpenAICompatibleLMProvider` | OpenAI-compatible | `apiKey` | `xAIProvider.ts` |
| **Ollama** | `OllamaLMProvider` | `AbstractOpenAICompatibleLMProvider` | OpenAI-compatible (local) | `None` | `ollamaProvider.ts` |
| **OpenRouter** | `OpenRouterLMProvider` | `AbstractOpenAICompatibleLMProvider` | OpenAI + Anthropic Messages | `apiKey` | `openRouterProvider.ts` |
| **Azure** | `AzureBYOKModelProvider` | `AbstractCustomOAIBYOKModelProvider` | Azure OpenAI | `apiKey` or `Entra ID` | `azureProvider.ts` |
| **Custom OAI** | `CustomOAIBYOKModelProvider` | `AbstractCustomOAIBYOKModelProvider` | OpenAI-compatible | `apiKey` | `customOAIProvider.ts` |
| **Custom Endpoint** | `CustomEndpointBYOKModelProvider` | `AbstractOpenAICompatibleLMProvider` | Any (Chat/Responses/Messages) | `apiKey` | `customEndpointProvider.ts` |

### 1.2 Two Provider Categories

```
Category 1: Native API Providers (direct SDK clients)
├── AnthropicLMProvider      — @anthropic-ai/sdk
├── GeminiNativeBYOKLMProvider — @google/genai

Category 2: OpenAI-Compatible Providers (reuse OpenAIEndpoint)
├── OAIBYOKLMProvider
├── XAIBYOKLMProvider
├── OllamaLMProvider
├── OpenRouterLMProvider
├── AzureBYOKModelProvider
├── CustomOAIBYOKModelProvider
├── CustomEndpointBYOKModelProvider
```

---

## 2. Architecture Overview

### 2.1 Class Hierarchy

```
LanguageModelChatProvider (VS Code API interface)
│
└── AbstractLanguageModelChatProvider<C, T>      ← Native API base
    ├── AnthropicLMProvider
    ├── GeminiNativeBYOKLMProvider
    │
    └── AbstractOpenAICompatibleLMProvider<T>     ← OpenAI-compatible base
        ├── OAIBYOKLMProvider
        ├── XAIBYOKLMProvider
        ├── OllamaLMProvider
        ├── OpenRouterLMProvider
        │
        └── AbstractCustomOAIBYOKModelProvider    ← Custom OAI base
            ├── AzureBYOKModelProvider
            └── CustomOAIBYOKModelProvider
```

### 2.2 Key Design Patterns

1. **Template Method Pattern**: `AbstractLanguageModelChatProvider` defines the skeleton (`provideLanguageModelChatInformation`, `provideLanguageModelChatResponse`), subclasses implement `getAllModels()` and provide response handling.

2. **Strategy for Endpoints**: `AbstractOpenAICompatibleLMProvider` creates `OpenAIEndpoint` objects via `createOpenAIEndPoint()`, letting subclasses customize URL resolution and model info.

3. **Wrapper Pattern**: The `CopilotLanguageModelWrapper` is shared across all providers and handles response streaming, token counting, error handling, and telemetry.

4. **Message Converter Pattern**: Each native API provider (Anthropic, Gemini) has a dedicated message converter in `byok/common/` that translates between VS Code `LanguageModelChatMessage` and the provider's native message format.

---

## 3. Class Hierarchy & Provider Patterns

### 3.1 AbstractLanguageModelChatProvider (Base)

**File:** `byok/vscode-node/abstractLanguageModelChatProvider.ts`

This is the **ultimate base class** for all BYOK providers. It implements `LanguageModelChatProvider<T>` from the VS Code API.

```typescript
abstract class AbstractLanguageModelChatProvider<
    C extends LanguageModelChatConfiguration = LanguageModelChatConfiguration,
    T extends ExtendedLanguageModelChatInformation<C> = ExtendedLanguageModelChatInformation<C>
> implements LanguageModelChatProvider<T> {

    constructor(
        protected readonly _id: string,              // e.g. 'anthropic'
        protected readonly _name: string,            // e.g. 'Anthropic'
        protected _knownModels: BYOKKnownModels | undefined,
        protected readonly _byokStorageService: IBYOKStorageService,
        @ILogService protected readonly _logService: ILogService,
    ) {}

    // === Implemented (shared logic) ===
    async provideLanguageModelChatInformation({ silent, configuration }): Promise<T[]> {
        // 1. Resolve API key from configuration or storage
        // 2. Call abstract getAllModels()
        // 3. Attach apiKey and configuration to each model
    }

    // === Abstract (provider-specific) ===
    abstract provideLanguageModelChatResponse(...): Promise<void>;
    abstract provideTokenCount(...): Promise<number>;
    protected abstract getAllModels(silent, apiKey, configuration?): Promise<T[]>;

    updateKnownModels(knownModels): void {
        // Merge known models from server-side list
    }
}
```

### 3.2 AbstractOpenAICompatibleLMProvider (OpenAI-Compatible)

```typescript
abstract class AbstractOpenAICompatibleLMProvider<
    T extends LanguageModelChatConfiguration = LanguageModelChatConfiguration
> extends AbstractLanguageModelChatProvider<T, OpenAICompatibleLanguageModelChatInformation<T>> {

    protected readonly _lmWrapper: CopilotLanguageModelWrapper;

    // === Provides default implementations ===
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const endpoint = await this.createOpenAIEndPoint(model);
        return this._lmWrapper.provideLanguageModelResponse(
            endpoint, messages, options, options.requestInitiator, progress, token
        );
    }

    async provideTokenCount(model, text, token) {
        const endpoint = await this.createOpenAIEndPoint(model);
        return this._lmWrapper.provideTokenCount(endpoint, text);
    }

    // === Subclass customization points ===
    protected async createOpenAIEndPoint(model): Promise<OpenAIEndpoint> { /* ... */ }
    protected getModelInfo(modelId, modelUrl): IChatModelInformation { /* ... */ }
    protected resolveModelCapabilities(modelData): BYOKModelCapabilities | undefined { /* ... */ }
    protected abstract getModelsBaseUrl(configuration): string | undefined;
    protected getModelsDiscoveryUrl(baseUrl): string { /* default */ }
}
```

### 3.3 Provider Lifecycle

```
1. BYOKContrib._applyPolicy()
   ├── Checks isClientBYOKAllowed()
   ├── Builds providers if not built
   └── Calls lm.registerLanguageModelChatProvider(vendor, provider)

2. VS Code calls provider.provideLanguageModelChatInformation()
   └── Provider resolves API key, calls getAllModels(), returns model list

3. User sees models in model picker, selects one

4. VS Code calls provider.provideLanguageModelChatResponse()
   └── Provider converts messages, calls API, streams response back

5. On auth change or policy change:
   └── BYOKContrib._applyPolicy() re-evaluates, registers/unregisters
```

---

## 4. Provider-by-Provider Deep Analysis

### 4.1 AnthropicLMProvider (Native SDK)

**File:** `byok/vscode-node/anthropicProvider.ts` (~800 lines)

**Key characteristics:**
- Extends `AbstractLanguageModelChatProvider` directly (not OpenAI-compatible)
- Uses `@anthropic-ai/sdk` npm package directly
- Has its own message converter: `anthropicMessageConverter.ts`
- Full support for: streaming, thinking, tool calls, citations, web search, cache control

**Constructor:**
```typescript
constructor(
    knownModels: BYOKKnownModels | undefined,
    byokStorageService: IBYOKStorageService,
    @ILogService logService,
    @IRequestLogger private readonly _requestLogger,
    @IConfigurationService private readonly _configurationService,
    @IExperimentationService private readonly _experimentationService,
    @ITelemetryService private readonly _telemetryService,
    @IOTelService private readonly _otelService,
    @IToolDeferralService private readonly _toolDeferralService,
) {
    super(AnthropicLMProvider.providerId, AnthropicLMProvider.providerName, 
          knownModels, byokStorageService, logService);
}
```

**Model Discovery (`getAllModels`):**
```typescript
protected async getAllModels(silent, apiKey): Promise<...> {
    const response = await new Anthropic({ apiKey }).models.list();
    const modelList: Record<string, BYOKModelCapabilities> = {};
    for (const model of response.data) {
        if (this._knownModels && this._knownModels[model.id]) {
            modelList[model.id] = this._knownModels[model.id];
        } else {
            // Fallback capabilities for unknown models
            modelList[model.id] = {
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                name: model.display_name,
                toolCalling: true,
                vision: false,
                thinking: false
            };
        }
    }
    return byokKnownModelsToAPIInfoWithEffort(this._name, modelList);
}
```

**Response Handling (`provideLanguageModelChatResponse`):**

The flow is:
1. Restore `CapturingToken` and OTel trace context from `modelOptions`
2. Create Anthropic SDK client: `new Anthropic({ apiKey })`
3. Convert messages: `apiMessageToAnthropicMessage(messages)` → returns `{ system, messages }`
4. Configure capabilities: thinking budget, betas, tools, context management
5. Log request: `this._requestLogger.logChatRequest('AnthropicBYOK', ...)`
6. Send request via private `_makeRequest()` method
7. Process streaming response chunks
8. Report telemetry and usage

**Thinking Budget:**
```typescript
private _getThinkingBudget(modelId, maxOutputTokens): number | undefined {
    const modelCapabilities = this._knownModels?.[modelId];
    if (!modelCapabilities?.thinking) return undefined;
    return Math.min(32000, maxOutputTokens - 1, 16000);
}
```

**Beta Features:**
```typescript
const betas: string[] = [];
if (thinkingBudget && !supportsAdaptiveThinking) {
    betas.push('interleaved-thinking-2025-05-14');
}
if (hasMemoryTool || contextManagement) {
    betas.push('context-management-2025-06-27');
}
if (toolSearchEnabled) {
    betas.push('advanced-tool-use-2025-11-20');
}
```

**Stream Processing (in `_makeRequest`):**

Handles chunk types:
- `content_block_delta` → `text_delta`, `citations_delta`, `thinking_delta`
- `content_block_start` → `tool_use`, `thinking`, `redacted_thinking`
- `content_block_stop` → Finalize pending tool call or thinking
- `message_start` → Capture prompt token usage
- `message_delta` → Capture completion token usage/stop reason
- `message_stop` → Finalize
- `web_search_tool_result` → Handle server-side web search tools

**Tool Handling:**
- Native Anthropic tool types: `memory_20250818`, `web_search_2025_10_22`
- Standard `tool_use`/`tool_result` conversion
- Domain filtering for web search tools

### 4.2 GeminiNativeBYOKLMProvider (Native SDK)

**File:** `byok/vscode-node/geminiNativeProvider.ts` (~537 lines)

**Key characteristics:**
- Extends `AbstractLanguageModelChatProvider` directly
- Uses `@google/genai` SDK
- Has its own message converter: `geminiMessageConverter.ts`
- Full support for: streaming, tools

**Model Discovery:**
```typescript
protected async getAllModels(silent, apiKey): Promise<...> {
    const client = new GoogleGenAI({ apiKey });
    const models = await client.models.list();
    const modelList: Record<string, BYOKModelCapabilities> = {};
    for await (const model of models) {
        const modelId = model.name;
        if (this._knownModels && this._knownModels[modelId]) {
            modelList[modelId] = this._knownModels[modelId];
        }
    }
    return byokKnownModelsToAPIInfo(this._name, modelList);
}
```

**Response handling:** Similar pattern to Anthropic — captures OTel context, logs request, converts messages, makes API call, streams response.

### 4.3 OAIBYOKLMProvider (OpenAI-Compatible — Simplest Example)

**File:** `byok/vscode-node/openAIProvider.ts` (~54 lines)

**Key characteristics:**
- Extends `AbstractOpenAICompatibleLMProvider`
- **The simplest possible provider** — minimal override
- Reuses all default implementations

```typescript
export class OAIBYOKLMProvider extends AbstractOpenAICompatibleLMProvider {
    public static readonly providerName = 'OpenAI';
    public static readonly providerId = this.providerName.toLowerCase();

    constructor(
        knownModels: BYOKKnownModels,
        byokStorageService: IBYOKStorageService,
        // ...standard DI services...
    ) {
        super(providerId, providerName, knownModels, byokStorageService, 
              fetcherService, logService, instantiationService, 
              configurationService, expService);
    }

    protected override getModelsBaseUrl(): string {
        return 'https://api.openai.com/v1';
    }

    protected override getModelInfo(modelId: string, modelUrl: string): IChatModelInformation {
        const modelInfo = super.getModelInfo(modelId, modelUrl);
        modelInfo.supported_endpoints = [
            ModelSupportedEndpoint.ChatCompletions,
            ModelSupportedEndpoint.Responses
        ];
        return modelInfo;
    }
}
```

**This is the minimum viable BYOK provider pattern.**

### 4.4 XAIBYOKLMProvider (OpenAI-Compatible with Custom Model Discovery)

**File:** `byok/vscode-node/xAIProvider.ts` (~106 lines)

**Key characteristics:**
- Extends `AbstractOpenAICompatibleLMProvider`
- Custom model discovery URL
- Custom capability parsing

```typescript
export class XAIBYOKLMProvider extends AbstractOpenAICompatibleLMProvider {
    public static readonly providerName = 'xAI';
    public static readonly providerId = this.providerName.toLowerCase();

    protected getModelsBaseUrl(): string | undefined {
        return 'https://api.x.ai/v1';
    }

    protected override getModelsDiscoveryUrl(modelsBaseUrl: string): string {
        return `${modelsBaseUrl}/language-models`;  // Custom endpoint
    }

    protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
        // Custom parsing of xAI's model list format
        const data = modelData as XAIModelData;
        return {
            maxInputTokens: data.max_input_tokens ?? 100000,
            maxOutputTokens: data.max_output_tokens ?? 16000,
            name: data.name ?? data.id ?? 'Unknown',
            toolCalling: data.capabilities?.tool_calling ?? false,
            vision: data.capabilities?.vision ?? false,
            thinking: data.capabilities?.thinking ?? false,
        };
    }

    private humanizeXAIModelId(modelId: string): string {
        return modelId.split('/').pop() || modelId;
    }
}
```

### 4.5 OllamaLMProvider (OpenAI-Compatible, No API Key)

**File:** `byok/vscode-node/ollamaProvider.ts`

**Key characteristics:**
- Extends `AbstractOpenAICompatibleLMProvider`
- No API key required (BYOKAuthType.None)
- Local model discovery from Ollama server
- Migration from old config format

```typescript
export class OllamaLMProvider extends AbstractOpenAICompatibleLMProvider<OllamaConfig> {
    public static readonly providerName = 'Ollama';
    public static readonly providerId = this.providerName.toLowerCase();

    constructor(...) {
        super(providerId, providerName, undefined, /* no knownModels */ ...);
        this.migrateConfig();
    }

    protected override async createOpenAIEndPoint(model): Promise<OpenAIEndpoint> {
        const modelInfo = resolveModelInfo(model.id, this._name);
        const ollamaHost = model.configuration?.ollamaHost || 'http://localhost:11434';
        return this._instantiationService.createInstance(OpenAIEndpoint, 
            modelInfo, '', `${ollamaHost}/v1/chat/completions`);
    }

    protected getModelsBaseUrl(configuration): string | undefined {
        return configuration?.ollamaHost || 'http://localhost:11434';
    }
}
```

### 4.6 OpenRouterLMProvider (Multi-Protocol)

**File:** `byok/vscode-node/openRouterProvider.ts`

**Key characteristics:**
- Routes Anthropic models through native Messages API
- Routes other models through Chat Completions
- Uses `OpenRouterEndpoint` (extends `OpenAIEndpoint`)

```typescript
export class OpenRouterLMProvider extends AbstractOpenAICompatibleLMProvider {
    protected override async createOpenAIEndPoint(model): Promise<OpenAIEndpoint> {
        const isAnthropic = isAnthropicModelId(model.id);
        if (isAnthropic) {
            modelInfo.supported_endpoints = [ModelSupportedEndpoint.Messages];
        }
        const url = isAnthropic 
            ? `${model.url}/messages` 
            : `${model.url}/chat/completions`;
        return this._instantiationService.createInstance(
            OpenRouterEndpoint, modelInfo, apiKey ?? '', url);
    }
}
```

### 4.7 AzureBYOKModelProvider (Custom Auth)

**File:** `byok/vscode-node/azureProvider.ts` (~139 lines)

**Key characteristics:**
- Extends `AbstractCustomOAIBYOKModelProvider`
- Supports both API key and Entra ID authentication
- Uses `AzureOpenAIEndpoint` for Entra ID token support

```typescript
export class AzureBYOKModelProvider extends AbstractCustomOAIBYOKModelProvider {
    override async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        if (model.configuration?.apiKey) {
            return super.provideLanguageModelChatResponse(model, messages, options, progress, token);
        }
        // Entra ID auth flow
        const session = await vscode.authentication.getSession(
            AzureAuthMode.MICROSOFT_AUTH_PROVIDER,
            [AzureAuthMode.COGNITIVE_SERVICES_SCOPE],
            { createIfNone: true, silent: false }
        );
        const openAIChatEndpoint = this._instantiationService.createInstance(
            AzureOpenAIEndpoint, modelInfo, session.accessToken, url);
        return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, ...);
    }
}
```

---

## 5. Shared Infrastructure

### 5.1 BYOKModelInfo & Conversion

**File:** `byok/vscode-node/byokModelInfo.ts`

```typescript
// Converts BYOKKnownModels map → LanguageModelChatInformation[]
export function byokKnownModelsToAPIInfoWithEffort(
    providerName: string, 
    knownModels: BYOKKnownModels
): LanguageModelChatInformation[];

// Single model conversion
export function byokKnownModelToAPIInfo(
    providerName: string, 
    id: string, 
    capabilities: BYOKModelCapabilities
): LanguageModelChatInformation;
```

### 5.2 BYOKModelCapabilities

```typescript
interface BYOKModelCapabilities {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    name?: string;
    toolCalling?: boolean;
    vision?: boolean;
    thinking?: boolean;
    supportsReasoningEffort?: string[];
    defaultReasoningEffort?: string;
    editTools?: string[];
}
```

### 5.3 BYOKKnownModels — Server-Side Model Registry

```typescript
type BYOKKnownModels = Record<string, BYOKModelCapabilities>;

// Fetched from https://main.vscode-cdn.net/extensions/copilotChat.json
// Format: { version: 1, modelInfo: { "<provider>": { "<modelId>": { ... }, ... }, ... } }
```

### 5.4 CopilotLanguageModelWrapper (Shared Response Handler)

**File:** `conversation/vscode-node/languageModelAccess.ts` (~760 lines)

Used by both the built-in `copilot` provider and BYOK providers. This is the **core engine** that:

1. Validates extensions (blocked extensions, quotas)
2. Calculates token budgets
3. Builds prompts with safety rules
4. Makes API requests via `chatMLFetcher`
5. Streams responses (text, tool calls, thinking parts)
6. Reports usage & telemetry data
7. Handles errors (rate limited, quota exceeded, blocked)

```typescript
class CopilotLanguageModelWrapper extends Disposable {
    async provideLanguageModelResponse(
        endpoint: IChatEndpoint,          // The resolved endpoint
        messages: Array<...>,              // Converted messages
        options: ProvideLanguageModelChatResponseOptions,
        extensionId: string | undefined,   // Which extension called
        progress: Progress<LMResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 1. Check extension is not blocked
        // 2. Calculate token budgets
        // 3. Build prompt with safety rules
        // 4. Make API request with streaming
        // 5. Stream text, tool calls, thinking parts
        // 6. Report LanguageModelDataPart with usage
    }

    async provideTokenCount(endpoint, message): Promise<number> {
        // Count tokens for a message using endpoint's tokenizer
    }
}
```

### 5.5 OpenAIEndpoint (Endpoint Abstraction)

The `OpenAIEndpoint` (and its subclasses) wraps model configuration into the `IChatEndpoint` interface:

```typescript
interface IChatEndpoint {
    readonly model: string;
    readonly modelProvider: string;
    readonly apiType?: string;
    readonly supportsToolCalls: boolean;
    readonly supportsVision: boolean;
    readonly supportsPrediction: boolean;
    readonly customModel?: CustomModel;
    readonly isExtensionContributed?: boolean;
    // ...
}
```

---

## 6. Message Conversion Patterns

### 6.1 Anthropic Message Converter

**File:** `byok/common/anthropicMessageConverter.ts` (~294 lines)

Three conversion functions:

```typescript
// 1. VS Code API → Anthropic SDK format (for request)
export function apiMessageToAnthropicMessage(
    messages: LanguageModelChatMessage[]
): { messages: MessageParam[]; system: TextBlockParam };

// 2. Anthropic SDK → Raw format for logging
export function anthropicMessagesToRawMessagesForLogging(
    messages: MessageParam[], 
    system: TextBlockParam
): Raw.ChatMessage[];

// 3. Anthropic SDK → Raw format for endpoints (full fidelity)
export function anthropicMessagesToRawMessages(
    messages: MessageParam[], 
    system: TextBlockParam
): Raw.ChatMessage[];
```

**Key conversion patterns:**

For `apiMessageToAnthropicMessage`:
- System messages → accumulated into `system: TextBlockParam`
- Assistant messages → `role: 'assistant'` with converted content
- User messages → `role: 'user'` with converted content
- Adjacent same-role messages → merged (Anthropic requirement)
- Thinking parts → `type: 'thinking'` / `type: 'redacted_thinking'`
- Tool calls → `type: 'tool_use'` with id, name, input
- Tool results → `type: 'tool_result'` with tool_use_id
- Images → `type: 'image'` with base64/url source
- Cache control → `cache_control: { type: 'ephemeral' }` on content blocks

### 6.2 OpenAI-Compatible Conversion

For OpenAI-compatible providers, the `OpenAIEndpoint` handles message conversion internally — no custom converter needed. The messages are passed through as-is.

### 6.3 Gemini Message Converter

Similar pattern to Anthropic — `apiMessageToGeminiMessage()` and `geminiMessagesToRawMessagesForLogging()`.

---

## 7. Telemetry & Observability Layer

### 7.1 Common Telemetry Pattern

Every provider follows this exact pattern:

```typescript
async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    // 1. Restore context
    const correlationId = (options as { modelOptions?: OTelModelOptions })
        .modelOptions?._capturingTokenCorrelationId;
    const capturingToken = correlationId ? retrieveCapturingTokenByCorrelation(correlationId) : undefined;
    const parentTraceContext = (options as { modelOptions?: OTelModelOptions })
        .modelOptions?._otelTraceContext ?? undefined;

    // 2. Create OTel span
    let otelSpan: ReturnType<typeof this._otelService.startSpan> | undefined;

    const doRequest = async () => {
        const issuedTime = Date.now();
        // ... make API call ...

        // 3. Start span with OTel attributes
        otelSpan = this._otelService.startSpan({
            [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
            [GenAiAttr.PROVIDER_NAME]: GenAiProviderName.ANTHROPIC,
            [GenAiAttr.REQUEST_MODEL]: model.id,
            [GenAiAttr.AGENT_NAME]: 'AnthropicBYOK',
            [CopilotChatAttr.MAX_PROMPT_TOKENS]: model.maxInputTokens,
            [StdAttr.SERVER_ADDRESS]: 'api.anthropic.com',
        });

        // 4. Log request
        const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
            'AnthropicBYOK', { model, ... }, { messages, ... }
        );

        // 5. Make request
        const result = capturingToken 
            ? await runWithCapturingToken(capturingToken, doRequest)
            : await doRequest();

        // 6. Record telemetry
        this._telemetryService.sendTelemetryEvent('chatResponse', {
            requestId, model, modelInvoked: model.id,
            isBYOK: 1,
            // ... timing, token counts ...
        });

        // 7. End span
        otelSpan.setStatus(SpanStatusCode.OK);
        otelSpan.end();
    };

    // 8. Run with trace context
    if (parentTraceContext) {
        return this._otelService.runWithTraceContext(parentTraceContext, executeRequest);
    }
    return executeRequest();
}
```

### 7.2 OTel Attributes Used

```typescript
GenAiAttr.OPERATION_NAME     // 'chat'
GenAiAttr.PROVIDER_NAME      // 'anthropic', 'openai', 'gemini', etc.
GenAiAttr.REQUEST_MODEL      // model.id
GenAiAttr.AGENT_NAME         // 'AnthropicBYOK'
GenAiAttr.INPUT_MESSAGES     // opt-in: captured messages
GenAiAttr.OUTPUT_MESSAGES    // opt-in: captured responses
GenAiAttr.USAGE_INPUT_TOKENS  // prompt token count
GenAiAttr.USAGE_OUTPUT_TOKENS // completion token count
GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS  // cached tokens
GenAiAttr.RESPONSE_MODEL     // model.id
GenAiAttr.RESPONSE_ID        // request id
GenAiAttr.RESPONSE_FINISH_REASONS  // ['stop']

CopilotChatAttr.MAX_PROMPT_TOKENS  // model.maxInputTokens
CopilotChatAttr.TIME_TO_FIRST_TOKEN  // ttft

StdAttr.SERVER_ADDRESS       // 'api.anthropic.com'
```

---

## 8. API Key Storage & Management

### 8.1 BYOKStorageService

**File:** `byok/vscode-node/byokStorageService.ts` (~169 lines)

```typescript
export class BYOKStorageService implements IBYOKStorageService {
    constructor(extensionContext: IVSCodeExtensionContext) {
        this._extensionContext = extensionContext;
    }

    async getAPIKey(providerName: string, modelId?: string): Promise<string | undefined> {
        // 1. Try model-specific key: copilot-byok-{provider}-{modelId}-api-key
        // 2. Fall back to provider key: copilot-byok-{provider}-api-key
    }

    async storeAPIKey(providerName: string, apiKey: string, authType: BYOKAuthType, modelId?: string) {
        // BYOKAuthType.None → no storage
        // BYOKAuthType.GlobalApiKey → provider-level key
        // BYOKAuthType.PerModelDeployment → model-specific key
    }

    async deleteAPIKey(providerName: string, authType: BYOKAuthType, modelId?: string) { /* ... */ }

    async getStoredModelConfigs(providerName: string): Promise<Record<string, StoredModelConfig>> {
        // Stored in globalState: copilot-byok-{provider}-models-config
    }

    async saveModelConfig(modelId, providerName, config, authType) { /* ... */ }
    async removeModelConfig(modelId, providerName, isDeletingCustomModel) { /* ... */ }
}
```

### 8.2 Key Auth Types

```typescript
enum BYOKAuthType {
    None,               // No key needed (Ollama, local models)
    GlobalApiKey,       // Single key for all models (Anthropic, OpenAI, Gemini)
    PerModelDeployment  // Separate key per model (Azure, Custom OAI)
}
```

### 8.3 API Key Configuration Injection

API keys are injected into `LanguageModelChatInformation` at provision time:

```typescript
// In AbstractLanguageModelChatProvider.provideLanguageModelChatInformation:
const models = await this.getAllModels(silent, apiKey, configuration);
return models.map(model => ({
    ...model,
    apiKey,           // ← attached for response handler
    configuration     // ← attached for response handler
}));
```

The `apiKey` flows from `model.configuration?.apiKey` in the response handler:

```typescript
// In AnthropicLMProvider.provideLanguageModelChatResponse:
const apiKey = model.configuration?.apiKey;
if (!apiKey) throw new Error('API key not found for the model');
const anthropicClient = new Anthropic({ apiKey });
```

---

## 9. Contribution & Registration Flow

### 9.1 BYOKContrib

**File:** `byok/vscode-node/byokContribution.ts` (~121 lines)

```typescript
export class BYOKContrib extends Disposable implements IExtensionContribution {
    public readonly id: string = 'byok-contribution';
    private readonly _providers = new Map<string, LanguageModelChatProvider>();
    private _providersRegistered = false;

    constructor(
        @IFetcherService private readonly _fetcherService,
        @ILogService private readonly _logService,
        @IVSCodeExtensionContext extensionContext,
        @IAuthenticationService private readonly _authService,
        @IInstantiationService private readonly _instantiationService,
    ) {
        super();
        this._byokStorageService = new BYOKStorageService(extensionContext);
        this._applyPolicy();  // Initial check
        this._register(this._authService.onDidAuthenticationChange(() => this._applyPolicy()));
    }

    private _applyPolicy(): void {
        const allowed = isClientBYOKAllowed(!!this._authService.anyGitHubSession, this._authService.copilotToken);
        if (allowed && !this._providersRegistered) {
            if (this._providers.size === 0) this._buildProviders();
            for (const [providerId, provider] of this._providers) {
                this._providerRegistrations.add(
                    lm.registerLanguageModelChatProvider(providerId, provider)
                );
            }
            this._providersRegistered = true;
            // Also refresh known models list
        } else if (!allowed && this._providersRegistered) {
            this._providerRegistrations.clear();
            this._providersRegistered = false;
        }
    }

    private _buildProviders(): void {
        const anthropic = instantiationService.createInstance(AnthropicLMProvider, undefined, this._byokStorageService);
        const gemini = instantiationService.createInstance(GeminiNativeBYOKLMProvider, undefined, this._byokStorageService);
        const xai = instantiationService.createInstance(XAIBYOKLMProvider, {}, this._byokStorageService);
        const openai = instantiationService.createInstance(OAIBYOKLMProvider, {}, this._byokStorageService);
        const ollama = instantiationService.createInstance(OllamaLMProvider, this._byokStorageService);
        // ... OpenRouter, Azure, CustomOAI, CustomEndpoint

        this._providers.set(AnthropicLMProvider.providerId, anthropic);
        this._providers.set(GeminiNativeBYOKLMProvider.providerId, gemini);
        this._providers.set(XAIBYOKLMProvider.providerId, xai);
        this._providers.set(OAIBYOKLMProvider.providerId, openai);
        this._providers.set(OllamaLMProvider.providerId, ollama);
        // ...
    }

    private async _refreshKnownModels(): Promise<void> {
        const data = await this._fetcherService.fetch(
            'https://main.vscode-cdn.net/extensions/copilotChat.json'
        );
        // Distribute known models to all providers
        for (const [id, provider] of this._knownModelsRefreshTargets) {
            provider.updateKnownModels(knownModelList[id]);
        }
    }
}
```

### 9.2 Registration as Contribution

```typescript
// In extension/vscode-node/contributions.ts:
export const vscodeNodeContributions = [
    // ...
    asContributionFactory(BYOKContrib),
    // ...
];
```

### 9.3 Policy Check

```typescript
export function isClientBYOKAllowed(
    hasGitHubSession: boolean, 
    copilotToken: CopilotToken | undefined
): boolean {
    if (!hasGitHubSession) return true;  // Signed-out users allowed
    if (!copilotToken) return false;     // Signed-in but no token → denied
    // Check token for BYOK entitlement
    return !!copilotToken.isBYOKAllowed;
}
```

---

## 10. OpenCode BYOK Implementation Blueprint

Based on this deep analysis, here is the recommended architecture for implementing BYOK in OpenCode:

### 10.1 Architecture Diagram

```
┌────────────────────────────────────────────────────┐
│                  OpenCode Application                │
├────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │         BYOK Provider System                 │   │
│  │                                               │   │
│  │  ┌──────────────┐   ┌──────────────────┐    │   │
│  │  │ Provider      │   │ Message           │    │   │
│  │  │ Registry      │   │ Converters        │    │   │
│  │  └──────┬───────┘   └──────────────────┘    │   │
│  │         │                                     │   │
│  │  ┌──────▼────────────────────────────────┐   │   │
│  │  │ AbstractLanguageModelChatProvider      │   │   │
│  │  │  ├─ AnthropicProvider                  │   │   │
│  │  │  ├─ OpenAIProvider                     │   │   │
│  │  │  ├─ GeminiProvider                     │   │   │
│  │  │  ├─ OpenRouterProvider                 │   │   │
│  │  │  └─ CustomEndpointProvider             │   │   │
│  │  └───────────────────────────────────────┘   │   │
│  │                                               │   │
│  │  ┌───────────────────────────────────────┐   │   │
│  │  │ Shared Infrastructure                  │   │   │
│  │  │  ├─ BYOKStorageService (API keys)      │   │   │
│  │  │  ├─ ModelInfoConverter                │   │   │
│  │  │  ├─ OTel Telemetry Layer              │   │   │
│  │  │  └─ Request Logger                    │   │   │
│  │  └───────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │         External Integration                 │   │
│  │  ├─ OpenAI-Compatible API (any provider)    │   │
│  │  ├─ Anthropic Messages API                  │   │
│  │  ├─ Google Gemini API                       │   │
│  │  └─ Custom protocol (Agent bridge)          │   │
│  └─────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────┘
```

### 10.2 Recommended File Structure

```
opencode-provider-bridge/
├── byok/
│   ├── __init__.py                     # Exports
│   ├── base_provider.py                # AbstractLanguageModelChatProvider
│   ├── openai_compatible_provider.py   # AbstractOpenAICompatibleLMProvider
│   │
│   ├── providers/
│   │   ├── anthropic_provider.py       # Anthropic (native Messages API)
│   │   ├── openai_provider.py          # OpenAI (Chat Completions + Responses)
│   │   ├── gemini_provider.py          # Google Gemini (native SDK)
│   │   ├── openrouter_provider.py      # OpenRouter (multi-protocol)
│   │   ├── ollama_provider.py          # Ollama (local, no key)
│   │   └── custom_endpoint_provider.py # Generic OpenAI-compatible
│   │
│   ├── converters/
│   │   ├── anthropic_converter.py      # Message converter for Anthropic
│   │   ├── gemini_converter.py         # Message converter for Gemini
│   │   └── openai_converter.py         # Default OpenAI converter
│   │
│   ├── storage/
│   │   └── key_storage.py             # API key management
│   │
│   └── telemetry/
│       ├── otel_attributes.py         # OTel attribute constants
│       └── usage_tracker.py           # Token usage tracking
│
└── opencode/
    ├── language_model.py              # LM integration point
    └── tools/
        └── tool_registry.py           # Tool registration
```

### 10.3 Implementation Priority Matrix

| Provider | Priority | Complexity | Pattern | Notes |
|----------|----------|------------|---------|-------|
| **OpenAI** | P0 | Low | OpenAI-compatible | Simplest — minimum code needed |
| **Anthropic** | P0 | High | Native SDK | Most complete reference impl |
| **OpenRouter** | P1 | Medium | OpenAI-compatible + Messages | Multi-model gateway |
| **Gemini** | P2 | Medium | Native SDK | Google's SDK integration |
| **Ollama** | P2 | Low | OpenAI-compatible | Local models, no API key |
| **Custom Endpoint** | P1 | Medium | OpenAI-compatible | Any OpenAI-compatible API |

### 10.4 Core Implementation (Python/TypeScript Template)

**Base Provider (TypeScript reference):**

```typescript
abstract class AbstractLanguageModelChatProvider<
    C = LanguageModelChatConfiguration,
    T = ExtendedLanguageModelChatInformation<C>
> {
    constructor(
        protected readonly id: string,
        protected readonly name: string,
        protected knownModels: Record<string, ModelCapabilities> | undefined,
        protected readonly storageService: IKeyStorageService,
        protected readonly logService: ILogService,
    ) {}

    // Main entry point — enumerate available models
    abstract getAllModels(
        silent: boolean,
        apiKey?: string,
        configuration?: C
    ): Promise<T[]>;

    // Main entry point — handle chat response
    abstract provideChatResponse(
        model: T,
        messages: ChatMessage[],
        options: ChatResponseOptions,
        progress: ProgressCallback,
        token: AbortSignal
    ): Promise<void>;

    // Token counting
    abstract provideTokenCount(
        model: T,
        text: string | ChatMessage
    ): Promise<number>;

    // Update known models from server
    updateKnownModels(knownModels: Record<string, ModelCapabilities>): void {
        this.knownModels = { ...this.knownModels, ...knownModels };
    }

    // Resolve API key from configuration or storage
    protected async resolveApiKey(configuration?: C): Promise<string | undefined> {
        const configKey = (configuration as any)?.apiKey;
        if (configKey) return configKey;
        return this.storageService.getAPIKey(this.id);
    }
}

// Model capabilities type
interface ModelCapabilities {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    name?: string;
    supportsToolCalling?: boolean;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    supportsReasoningEffort?: string[];
    defaultReasoningEffort?: string;
    editTools?: string[];
}
```

**OpenAI-Compatible Provider (minimum viable):**

```typescript
class OpenAICompatibleProvider extends AbstractLanguageModelChatProvider {
    static readonly providerName = 'OpenAI';
    static readonly providerId = 'opencode-openai';

    protected baseUrl = 'https://api.openai.com/v1';

    async getAllModels(silent: boolean, apiKey?: string, configuration?: any) {
        if (!apiKey && silent) return [];
        
        const response = await fetch(`${this.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` }
        });
        const data = await response.json();
        
        return data.data
            .filter((m: any) => m.id.startsWith('gpt-'))
            .map((m: any) => this.toModelInfo(m));
    }

    async provideChatResponse(model, messages, options, progress, token) {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${model.apiKey}`
            },
            body: JSON.stringify({
                model: model.id,
                messages: this.convertMessages(messages),
                stream: true,
                tools: options.tools,
            })
        });

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const lines = decoder.decode(value).split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    if (data.choices?.[0]?.delta?.content) {
                        progress.onText(data.choices[0].delta.content);
                    }
                }
            }
        }
    }

    async provideTokenCount(model, text) {
        if (typeof text === 'string') return Math.ceil(text.length / 4);
        return 0;
    }

    private toModelInfo(raw: any): LanguageModelChatInformation {
        return {
            id: raw.id,
            name: raw.id,
            vendor: this.name,
            maxInputTokens: 128000,
            maxOutputTokens: 4096,
            isUserSelectable: true,
            capabilities: {
                toolCalling: true,
                imageInput: raw.id.includes('vision'),
            },
        };
    }

    private convertMessages(messages: ChatMessage[]): any[] {
        return messages.map(m => ({
            role: m.role,
            content: m.content,
        }));
    }
}
```

**Anthropic Provider Reference Implementation Pattern:**

```typescript
class AnthropicProvider extends AbstractLanguageModelChatProvider {
    static readonly providerName = 'Anthropic';
    static readonly providerId = 'opencode-anthropic';

    async getAllModels(silent, apiKey) {
        if (!apiKey && silent) return [];
        
        const anthropic = new AnthropicSDK({ apiKey });
        const response = await anthropic.models.list();
        
        return response.data
            .filter(m => this.knownModels?.[m.id])
            .map(m => ({
                id: m.id,
                name: m.display_name,
                vendor: this.name,
                maxInputTokens: this.knownModels[m.id]?.maxInputTokens ?? 100000,
                maxOutputTokens: this.knownModels[m.id]?.maxOutputTokens ?? 16000,
                isUserSelectable: true,
                capabilities: {
                    toolCalling: this.knownModels[m.id]?.toolCalling ?? true,
                    imageInput: this.knownModels[m.id]?.vision ?? false,
                    editTools: this.knownModels[m.id]?.editTools,
                },
                configurationSchema: {
                    properties: {
                        reasoningEffort: {
                            type: 'string',
                            enum: ['low', 'medium', 'high'],
                            default: 'medium',
                        }
                    }
                }
            }));
    }

    async provideChatResponse(model, messages, options, progress, token) {
        const apiKey = model.configuration?.apiKey;
        const anthropic = new AnthropicSDK({ apiKey });
        
        const { system, messages: converted } = 
            apiMessageToAnthropicMessage(messages);

        const stream = await anthropic.beta.messages.create({
            model: model.id,
            messages: converted,
            max_tokens: model.maxOutputTokens,
            stream: true,
            system: [system],
            tools: options.tools?.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
            })),
        });

        for await (const chunk of stream) {
            if (token.aborted) break;
            
            if (chunk.type === 'content_block_delta') {
                if (chunk.delta.type === 'text_delta') {
                    progress.onText(chunk.delta.text);
                } else if (chunk.delta.type === 'thinking_delta') {
                    progress.onThinking(chunk.delta.thinking);
                }
            } else if (chunk.type === 'content_block_start') {
                if (chunk.content_block.type === 'tool_use') {
                    progress.onToolCall({
                        id: chunk.content_block.id,
                        name: chunk.content_block.name,
                        input: chunk.content_block.input,
                    });
                }
            }
        }
    }
}
```

### 10.5 Key Storage Architecture

```typescript
interface IKeyStorageService {
    getAPIKey(providerName: string, modelId?: string): Promise<string | undefined>;
    storeAPIKey(providerName: string, apiKey: string, modelId?: string): Promise<void>;
    deleteAPIKey(providerName: string, modelId?: string): Promise<void>;
}

// Implementation using secure storage
class SecureKeyStorage implements IKeyStorageService {
    constructor(private storage: SecureStorage) {}

    async getAPIKey(providerName: string, modelId?: string): Promise<string | undefined> {
        if (modelId) {
            const key = await this.storage.get(`byok-${providerName}-${modelId}`);
            if (key?.trim()) return key.trim();
        }
        const key = await this.storage.get(`byok-${providerName}`);
        return key?.trim() || undefined;
    }

    async storeAPIKey(providerName: string, apiKey: string, modelId?: string): Promise<void> {
        const key = modelId 
            ? `byok-${providerName}-${modelId}` 
            : `byok-${providerName}`;
        await this.storage.set(key, apiKey);
    }

    async deleteAPIKey(providerName: string, modelId?: string): Promise<void> {
        const key = modelId 
            ? `byok-${providerName}-${modelId}` 
            : `byok-${providerName}`;
        await this.storage.delete(key);
    }
}
```

### 10.6 Minimum Viable Integration Checklist

For each new provider, you need to implement:

- [ ] `providerName` / `providerId` static properties
- [ ] Constructor with DI services
- [ ] `getAllModels(silent, apiKey, configuration?)` — Enumerate models
- [ ] `provideChatResponse(model, messages, options, progress, token)` — Handle requests
- [ ] `provideTokenCount(model, text)` — Token estimation
- [ ] Message format conversion (if not OpenAI-compatible)
- [ ] OTel telemetry attributes for observability

### 10.7 Leveraging Existing Patterns from This Analysis

| Pattern | Where Used | Applies To |
|---------|-----------|------------|
| `CopilotLanguageModelWrapper` reuse | All providers via `_lmWrapper` | OpenAI-compatible providers |
| `RecordedProgress` for tracking stream items | Anthropic, Gemini | All streaming providers |
| `CapturingToken` + `runWithCapturingToken` | Anthropic, Gemini | Any IPC-crossing provider |
| `parentTraceContext` for OTel span linking | Anthropic, Gemini | All providers in agent context |
| `knownModels` from server-side manifest | Anthropic, OpenAI, xAI, Gemini | Providers with frequent model updates |
| `configureDefaultGroupWithApiKeyOnly()` | Abstract base | Providers needing key migration |
| `resolveModelCapabilities()` override | xAI | Providers with custom model list formats |
| Custom endpoint type for auth | Azure (Entra ID) | Providers with non-key auth |

---

## Appendix: Complete File Reference

### BYOK files in VS Code Copilot extension:

```
extensions/copilot/src/extension/byok/
├── common/
│   ├── byokProvider.ts                — BYOKKnownModels, BYOKModelCapabilities, isClientBYOKAllowed(), handleAPIKeyUpdate()
│   ├── anthropicMessageConverter.ts   — apiMessageToAnthropicMessage(), anthropicMessagesToRawMessages()
│   ├── geminiMessageConverter.ts      — apiMessageToGeminiMessage(), geminiMessagesToRawMessagesForLogging()
│   ├── geminiFunctionDeclarationConverter.ts — Tool → Gemini function declaration
│   └── test/
│       └── anthropicMessageConverter.spec.ts — Tests
├── vscode-node/
│   ├── abstractLanguageModelChatProvider.ts — Base class + OpenAI-compatible base
│   ├── byokContribution.ts            — BYOKContrib (registration, policy, refresh)
│   ├── byokStorageService.ts          — IBYOKStorageService implementation
│   ├── byokModelInfo.ts              — byokKnownModelsToAPIInfo*()
│   ├── anthropicProvider.ts           — AnthropicLMProvider (native SDK)
│   ├── geminiNativeProvider.ts        — GeminiNativeBYOKLMProvider (native SDK)
│   ├── openAIProvider.ts              — OAIBYOKLMProvider (simplest example)
│   ├── xAIProvider.ts                 — XAIBYOKLMProvider (custom discovery)
│   ├── ollamaProvider.ts              — OllamaLMProvider (no API key)
│   ├── openRouterProvider.ts          — OpenRouterLMProvider (multi-protocol)
│   ├── azureProvider.ts               — AzureBYOKModelProvider (Entra ID auth)
│   ├── customOAIProvider.ts           — CustomOAIBYOKModelProvider (abstract base)
│   ├── customEndpointProvider.ts      — CustomEndpointBYOKModelProvider
│   └── test/
│       ├── azureProvider.spec.ts
│       ├── geminiNativeProvider.spec.ts
│       └── openRouterEndpoint.spec.ts
```
