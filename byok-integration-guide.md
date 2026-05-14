# BYOK, Custom Models & External Agent Integration Guide

> **A comprehensive guide for integrating custom language models, BYOK providers, and external agents with VS Code Copilot**  
> **Analysis Date:** May 14, 2026

---

## Table of Contents

1. [Overview & Architecture](#1-overview--architecture)
2. [BYOK — Bring Your Own Key](#2-byok--bring-your-own-key)
3. [Built-in Model Providers](#3-built-in-model-providers)
4. [Custom Language Model Provider Extensions](#4-custom-language-model-provider-extensions)
5. [OpenAI-Compatible Provider Implementation](#5-openai-compatible-provider-implementation)
6. [External Agent Integration via Model Proxy](#6-external-agent-integration-via-model-proxy)
7. [Local & Remote Agent Integration](#7-local--remote-agent-integration)
8. [Session Context & Tracking](#8-session-context--tracking)
9. [Token Usage Tracking & Metering](#9-token-usage-tracking--metering)
10. [Customization Options](#10-customization-options)
11. [Security Considerations](#11-security-considerations)
12. [Complete Code Examples](#12-complete-code-examples)

---

## 1. Overview & Architecture

### 1.1 The Big Picture

VS Code Copilot's extensibility for custom models operates at multiple levels:

```
                         ┌─────────────────────────────────────────┐
                         │           VS Code Copilot               │
                         │  ┌───────────────────────────────────┐  │
                         │  │  Built-in Models (OpenAI, Claude, │  │
                         │  │  Gemini, etc.)                    │  │
                         │  └──────────────┬────────────────────┘  │
                         │                 │                        │
                         │  ┌──────────────▼────────────────────┐  │
                         │  │  BYOK Built-in Providers           │  │
                         │  │  • OpenAI API Key                  │  │
                         │  │  • Anthropic API Key               │  │
                         │  │  • Ollama (Local)                  │  │
                         │  │  • OpenAI Compatible               │  │
                         │  └──────────────┬────────────────────┘  │
                         │                 │                        │
                         │  ┌──────────────▼────────────────────┐  │
                         │  │  Extension Model Providers         │  │
                         │  │  (lm.registerLanguageModelChat-    │  │
                         │  │   Provider)                        │  │
                         │  └──────────────┬────────────────────┘  │
                         │                 │                        │
                         │  ┌──────────────▼────────────────────┐  │
                         │  │  External Agents (Model Proxy)     │  │
                         │  │  (lm.registerLanguageModelProxy-   │  │
                         │  │   Provider)                        │  │
                         │  └───────────────────────────────────┘  │
                         └─────────────────────────────────────────┘
```

### 1.2 Integration Levels

| Level | Mechanism | Requires | Use Case |
|-------|-----------|----------|----------|
| **1 — Built-in BYOK** | Settings UI / `github.copilot.chat.customOAIModels` | Copilot plan + API key | Quick custom model addition |
| **2 — Extension Provider** | `lm.registerLanguageModelChatProvider()` | VS Code proposed API `chatProvider` | Full model provider with custom UI |
| **3 — Model Proxy** | `lm.registerLanguageModelProxyProvider()` | VS Code proposed API `chatParticipantPrivate` + `languageModelProxy` | External agent integration |
| **4 — Chat Participant** | `chat.createChatParticipant()` | VS Code stable/proposed API | Custom chat agent experiences |
| **5 — Context Provider** | Copilot extension API `getContextProviderAPI('v1')` | Copilot extension | Provide context for completions |

---

## 2. BYOK — Bring Your Own Key

### 2.1 What BYOK Provides

BYOK allows you to use your own API keys for language models instead of the built-in Copilot models. Benefits:

- **Model choice**: Access hundreds of models from different providers
- **Experimentation**: Test new models/features not yet available as built-in
- **Local compute**: Run models on your own hardware
- **Greater control**: Bypass standard rate limits and restrictions

### 2.2 Limitations

- Only applies to **chat experience** — not inline suggestions or other AI features
- Capabilities are **model-dependent** (tool calling, vision, thinking may differ)
- Copilot service API still used for: embeddings, repo indexing, query refinement, intent detection, side queries
- **No guarantee** of responsible AI filtering on BYOK model output
- Still requires a **Copilot plan** (Free, Pro, Business, Enterprise)
- Requires **internet connection** (even for local models)

### 2.3 Configuration Methods

**Method 1: Language Models Editor (UI)**

1. Open model picker → Manage Models
2. Select Add Models → Choose provider
3. Enter API key/endpoint URL
4. Select model from available list

**Method 2: Settings (OpenAI-Compatible)**

```json
"github.copilot.chat.customOAIModels": {
    "my-custom-model": {
        "url": "https://api.myprovider.com/v1/chat/completions",
        "apiKey": "sk-...",
        "models": {
            "my-model-name": {
                "name": "My Model",
                "maxInputTokens": 128000,
                "maxOutputTokens": 4096
            }
        }
    }
}
```

### 2.4 Built-in BYOK Providers

| Provider | Type | Key Config | Model Discovery |
|----------|------|------------|-----------------|
| **OpenAI** | API Key | `sk-...` | Automatic via API |
| **Anthropic** | API Key | `sk-ant-...` | Automatic via API |
| **Ollama** | Endpoint URL | `http://localhost:11434` | Automatic via API |
| **OpenAI Compatible** | URL + Key | Custom | Manual or auto |

### 2.5 Enterprise Policy

For Copilot Business/Enterprise:

- Admin must enable **"Bring Your Own Language Model Key"** policy in GitHub settings
- Only applies to chat — inline suggestions remain on built-in models

---

## 3. Built-in Model Providers

### 3.1 Provider Implementation (Internal Architecture)

Each built-in BYOK provider extends `AbstractLanguageModelChatProvider`:

```typescript
// Abstract base for all BYOK providers
abstract class AbstractLanguageModelChatProvider<
    C extends LanguageModelChatConfiguration,
    T extends ExtendedLanguageModelChatInformation<C>
> implements LanguageModelChatProvider<T> {
    
    constructor(
        protected readonly _id: string,          // e.g., 'anthropic'
        protected readonly _name: string,        // e.g., 'Anthropic'
        protected _knownModels: BYOKKnownModels | undefined,
        protected readonly _byokStorageService: IBYOKStorageService,
        @ILogService protected readonly _logService: ILogService,
    ) {}
    
    // Handles API key management & storage
    // Provides model enumeration via getAllModels()
    // Delegates actual LM calls to CopilotLanguageModelWrapper
}
```

### 3.2 BYOK Provider Registration

```typescript
// byokContribution.ts
class BYOKContribution extends Disposable implements IExtensionContribution {
    readonly id = 'byokContribution';
    
    constructor(
        @IAuthenticationService authenticationService,
        @IVSCodeExtensionContext extensionContext,
        @IInstantiationService instantiationService,
    ) {
        super();
        
        // Register BYOK providers conditionally
        if (isClientBYOKAllowed()) {
            this._register(instantiationService.createInstance(AnthropicLMProvider));
            this._register(instantiationService.createInstance(OpenAICompatibleProvider));
            // ... other providers
        }
    }
}
```

### 3.3 BYOK Endpoint Integration

BYOK providers use the same `CopilotLanguageModelWrapper` as built-in models:

```typescript
abstract class AbstractOpenAICompatibleLMProvider<
    T extends LanguageModelChatConfiguration
> extends AbstractLanguageModelChatProvider<T, OpenAICompatibleLanguageModelChatInformation<T>> {
    
    protected readonly _lmWrapper: CopilotLanguageModelWrapper;
    
    async provideLanguageModelChatResponse(
        model: OpenAICompatibleLanguageModelChatInformation<T>,
        messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart2>,
        token: CancellationToken
    ): Promise<void> {
        // Create OpenAI-compatible endpoint from BYOK config
        const openAIChatEndpoint = await this.createOpenAIEndPoint(model);
        
        // Delegate to the same wrapper used by built-in Copilot models
        return this._lmWrapper.provideLanguageModelResponse(
            openAIChatEndpoint, 
            messages, 
            options, 
            options.requestInitiator,  // Track which extension initiated
            progress, 
            token
        );
    }
}
```

---

## 4. Custom Language Model Provider Extensions

### 4.1 Full Provider Extension Architecture

To build a complete custom model provider extension:

```typescript
// Step 1: Declare in package.json
{
    "contributes": {
        "languageModels": [{
            "vendor": "myVendor",
            "displayName": "My Custom Models",
            "configuration": {
                "properties": {
                    "apiKey": {
                        "type": "string",
                        "description": "API key for My Custom Models"
                    }
                }
            }
        }]
    },
    "enabledApiProposals": ["chatProvider"]
}

// Step 2: Implement the provider
export function activate(context: vscode.ExtensionContext) {
    const provider: vscode.LanguageModelChatProvider = {
        onDidChangeLanguageModelChatInformation: /* event */,
        
        provideLanguageModelChatInformation: async (options, token) => {
            return [{
                id: 'my-model',
                name: 'My Awesome Model',
                vendor: 'myVendor',
                version: '1.0',
                maxInputTokens: 128000,
                maxOutputTokens: 4096,
                isUserSelectable: true,
                capabilities: {
                    imageInput: false,
                    toolCalling: true,
                },
                configurationSchema: {
                    properties: {
                        temperature: {
                            type: 'number',
                            default: 0.7,
                            description: 'Controls randomness'
                        }
                    }
                }
            }];
        },
        
        provideLanguageModelChatResponse: async (model, messages, options, progress, token) => {
            // Call your custom model API
            const response = await callMyAPI(messages);
            
            // Stream response parts
            for (const chunk of response) {
                progress.report(new vscode.LanguageModelTextPart(chunk.text));
                
                if (chunk.toolCalls) {
                    for (const tc of chunk.toolCalls) {
                        progress.report(new vscode.LanguageModelToolCallPart(
                            tc.id, tc.name, tc.arguments
                        ));
                    }
                }
            }
        },
        
        provideTokenCount: async (model, text, token) => {
            return estimateTokenCount(text);
        }
    };
    
    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('myVendor', provider)
    );
}
```

### 4.2 Provider Lifecycle

1. **Declaration**: Extension contributes a `languageModels` vendor in `package.json`
2. **Registration**: Extension calls `lm.registerLanguageModelChatProvider()` during activation
3. **Model Enumeration**: VS Code calls `provideLanguageModelChatInformation()` to discover models
4. **Configuration**: User configures API keys via Language Models editor (uses declared schema)
5. **Chat Requests**: When user selects the model, `provideLanguageModelChatResponse()` is called
6. **Cleanup**: Disposing the returned `Disposable` unregisters the provider

### 4.3 Configuration Schema

The `configurationSchema` in `LanguageModelChatInformation` defines user-configurable properties:

```typescript
type LanguageModelConfigurationSchema = {
    properties?: {
        [key: string]: Record<string, any> & {
            enumItemLabels?: string[];    // Labels for enum values
            group?: string;               // 'navigation' for primary UI placement
        };
    };
};
```

This schema drives the Language Models editor UI automatically.

---

## 5. OpenAI-Compatible Provider Implementation

### 5.1 Internal OpenAI Endpoint

The `AbstractOpenAICompatibleLMProvider` creates an internal `OpenAIEndpoint` that wraps the BYOK model:

```typescript
// The internal endpoint wraps BYOK config into IChatEndpoint
interface IChatEndpoint extends IEndpoint {
    readonly model: string;
    readonly modelProvider: string;
    readonly supportsToolCalls: boolean;
    readonly supportsVision: boolean;
    readonly customModel?: CustomModel;
    // ...
}

// Extension-contributed endpoints
class ExtensionContributedChatEndpoint implements IChatEndpoint {
    readonly isExtensionContributed = true;
    
    constructor(private languageModel: vscode.LanguageModelChat) {
        this._maxTokens = languageModel.maxInputTokens;
    }
    
    get modelProvider() { return this.languageModel.vendor; }
    get model() { return this.languageModel.id; }
    get supportsToolCalls() { 
        return this.languageModel.capabilities?.supportsToolCalling ?? false; 
    }
    get supportsVision() {
        return this.languageModel.capabilities?.supportsImageToText ?? false;
    }
}
```

### 5.2 Using the CopilotLanguageModelWrapper

BYOK providers reuse the same response handling pipeline:

```typescript
// The wrapper handles:
// 1. Token counting and budget validation
// 2. Prompt assembly with safety rules
// 3. Streaming response parsing
// 4. Error handling (quota, rate limits, blocked)
// 5. Telemetry reporting
// 6. Tool call handling
// 7. Thinking/reasoning content

class CopilotLanguageModelWrapper {
    async provideLanguageModelResponse(
        endpoint: IChatEndpoint,
        messages: Array<...>,
        options: ProvideLanguageModelChatResponseOptions,
        extensionId: string | undefined,
        progress: Progress<LMResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 1. Validate extension
        // 2. Calculate token budgets
        // 3. Build prompt with safety rules
        // 4. Make API request
        // 5. Stream response (text, tool calls, thinking)
        // 6. Report usage data
    }
}
```

### 5.6 Stream Handling Parity — Verification Results

The `opencode-provider-bridge` extension has been verified against VS Code's official BYOK implementations (Anthropic, Gemini) and the built-in `CopilotLanguageModelWrapper`. All stream event types are correctly mapped.

#### Stream Event Mapping Table

| fullStream Event (AI SDK) | VS Code API Part | Official Anthropic BYOK | Official Gemini BYOK | OpenCode Bridge |
|---|---|---|---|---|
| `text-delta` | `LanguageModelTextPart` | ✅ `text_delta` per chunk | ✅ `part.text` per chunk | ✅ Same |
| `reasoning-delta` | `LanguageModelThinkingPart` (real-time) | ✅ `thinking_delta` → per-chunk | ✅ `thought=true` → per-chunk | ✅ Same |
| `reasoning-start` | `LanguageModelThinkingPart('')` (trigger animation) | ✅ Pending thinking initialized | ✅ `thoughtSignature` captured | ✅ Same |
| `reasoning-end` | `LanguageModelThinkingPart` with `vscode_reasoning_done: true` | ✅ Thinking finalized with signature | ✅ Thinking part with metadata | ✅ Same (with dedup) |
| `tool-call` | `LanguageModelToolCallPart` | ✅ `tool_use` content_block | ✅ `functionCall` part | ✅ Same |
| `tool-result` | `LanguageModelToolResultPart` | ✅ `tool_result` content | ✅ Via internal tracking | ✅ Same |
| `error` | Classified `LanguageModelError` | ✅ Via framework | ✅ Via framework | ✅ Rate/Auth/Quota/Generic |
| `finish` (usage) | `LanguageModelDataPart('usage')` | ✅ `LanguageModelDataPart` | ✅ `LanguageModelDataPart` | ✅ Same |

#### Key Design Differences

| Aspect | Official BYOK Providers | OpenCode Bridge |
|---|---|---|
| **HTTP layer** | Manual SSE parsing + `ChatEndpoint` | `@ai-sdk/openai-compatible` (bundled SDK) |
| **Stream abstraction** | Raw `chunk.type` switch on Anthropic stream events | SDK `fullStream` normalized events |
| **Tool schema handling** | Server-side known model capabilities | Client-side `simplifySchema()` with caching |
| **Error classification** | `ChatFetchResponseType` enum | `statusCode` + message pattern matching |
| **Thinking dedup** | Separate pending thinking state | `reasoningEnded` flag to avoid duplicate UI triggers |

Despite different abstraction levels, the **wire format and VS Code response parts are identical** — the SDK handles the SSE parsing and the code maps the normalized events to the same VS Code API calls.

---

## 6. External Agent Integration via Model Proxy

### 6.1 Model Proxy Protocol

The model proxy system enables external agents to act as the Copilot language model. It works by starting a local HTTP server that exposes an OpenAI-compatible API:

```typescript
// Extension gets a proxy URI + key
const proxy = await vscode.lm.getModelProxy();

// Use the proxy to forward requests to any external agent
// proxy.uri = http://localhost:PORT
// proxy.key = "random-nonce"

// The external agent can then:
// 1. Receive forwarded Copilot requests
// 2. Process with its own model/agent logic
// 3. Return responses in OpenAI-compatible format
```

### 6.2 Internal Proxy Implementation

```typescript
// modelProxyProvider.ts
class LanguageModelProxyProvider implements vscode.LanguageModelProxyProvider {
    async provideModelProxy(
        forExtensionId: string, 
        token: CancellationToken
    ): Promise<vscode.LanguageModelProxy | undefined> {
        
        const server = this.instantiationService.createInstance(OpenAILanguageModelServer);
        await server.start();
        
        return new OpenAILanguageModelProxy(server);
    }
}

class OpenAILanguageModelProxy extends Disposable implements vscode.LanguageModelProxy {
    public readonly uri: Uri;   // http://localhost:{port}
    public readonly key: string; // Nonce for authentication
    
    constructor(runningServer: OpenAILanguageModelServer) {
        super();
        this._register(runningServer);
        
        const config = runningServer.getConfig();
        this.uri = URI.parse(`http://localhost:${config.port}`);
        this.key = config.nonce;
    }
}

// LanguageModelServer starts an OpenAI-compatible HTTP server
class LanguageModelServer implements ILanguageModelServer {
    // Handles:
    // - POST /v1/chat/completions
    // - OpenAI-compatible request/response format
    // - Forwards requests to the external agent
    // - Manages authentication via nonce
    // - Supports streaming responses
}
```

### 6.3 Registration & Enablement

```typescript
// Extension registers the proxy provider
class LanguageModelProxyContrib extends Disposable implements IExtensionContribution {
    constructor(
        @IAuthenticationService authenticationService,
        @IConfigurationService configurationService,
    ) {
        super();
        
        const updateRegistration = () => {
            const token = authenticationService.copilotToken;
            const enableProxy = token && (
                token.codexAgentEnabled || 
                configurationService.getNonExtensionConfig('chat.experimental.codex.enabled')
            );
            
            if (!providerDisposable.value && enableProxy) {
                providerDisposable.value = vscode.lm.registerLanguageModelProxyProvider(
                    instantiationService.createInstance(LanguageModelProxyProvider)
                );
            } else if (providerDisposable.value && !enableProxy) {
                providerDisposable.clear();
            }
        };
        
        this._register(Event.runAndSubscribe(
            authenticationService.onDidAuthenticationChange, 
            updateRegistration
        ));
    }
}
```

### 6.4 Using the Proxy from Another Extension

```typescript
// In another extension that wants to integrate an external agent:
const proxy = await vscode.lm.getModelProxy();

// Now you have:
// - proxy.uri: local server URI (e.g., http://localhost:4321)
// - proxy.key: authentication key

// You can configure your external agent to connect to this proxy
// The agent will receive Copilot requests forwarded by the proxy server
```

---

## 7. Local & Remote Agent Integration

### 7.1 Integration Patterns

```
                    ┌─────────────────────────────────────┐
                    │     External Agent Architecture      │
                    └─────────────────────────────────────┘

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Copilot Chat    │────▶│  Model Proxy     │────▶│  External Agent  │
│  (VS Code)       │     │  (Local HTTP)    │     │  (Any Process)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                          │
                                                  ┌───────┴────────┐
                                                  │  Local  │ Remote│
                                                  │  Model  │ API   │
                                                  └────────┴───────┘
```

### 7.2 Local Model Integration

For locally hosted models:

1. **Via BYOK**: Use the Ollama built-in provider (point to `http://localhost:11434`)
2. **Via Extension**: AI Toolkit extension provides Foundry Local support
3. **Via OpenAI-Compatible**: Configure custom OpenAI-compatible endpoint pointing to local server

**Requirements:**
- Still need Copilot plan (Free minimum)
- Still need internet connection
- Model must support the required capabilities (tool calling for agent mode)

### 7.3 Remote/Custom Agent Integration

For custom remote agents:

1. **Chat Participant Approach**: Use `chat.createChatParticipant()` for a custom `/agent` experience
2. **Model Proxy Approach**: Use `lm.getModelProxy()` + HTTP server for transparent replacement
3. **Provider Approach**: Use `lm.registerLanguageModelChatProvider()` for full model integration

### 7.4 The OpenAgents Protocol

The `LanguageModelServer` in the Copilot extension implements an OpenAI-compatible protocol:

```
POST /v1/chat/completions
Authorization: Bearer {key}

{
    "model": "...",
    "messages": [...],
    "stream": true,
    "tools": [...]
}
```

This allows any OpenAI-compatible agent to integrate with VS Code Copilot.

---

## 8. Session Context & Tracking

### 8.1 Session Lifecycle

```typescript
interface ISessionOptions {
    model?: string;
    workspace: IWorkspaceInfo;
    agent?: SweCustomAgent;
    debugTargetSessionIds?: readonly string[];
    mcpServerMappings?: McpServerMappings;
    additionalWorkspaces?: IWorkspaceInfo[];
}

interface ICopilotCLISessionService {
    createSession(options: ISessionOptions): Promise<...>;
    getSession(options: IGetSessionOptions): Promise<...>;
    deleteSession(sessionId: string): Promise<void>;
    sendRequest(sessionId, chatResource, options): Promise<...>;
}
```

### 8.2 Context Tracking Architecture

```
┌──────────────────┐
│  Chat Request     │
│  ┌────────────┐   │
│  │ ChatContext │   │
│  │ • history   │   │
│  │ • yield     │   │
│  │ • session   │   │
│  └────────────┘   │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Conversation     │
│  • sessionId      │
│  • Turn[]         │
│    ┌──────────┐   │
│    │ Turn     │   │
│    │ • id     │   │
│    │ • request│   │
│    │ • response│  │
│    └──────────┘   │
└──────────────────┘
```

### 8.3 Conversation Context

```typescript
class Conversation {
    constructor(
        public readonly sessionId: string,
        public readonly turns: Turn[]
    );
}

class Turn {
    static fromRequest(telemetryMessageId: string, request: ChatRequest): Turn;
    
    // Contains full request/response for a single interaction
    // Used for context window building
}
```

### 8.4 ChatContext Interface

```typescript
interface ChatContext {
    readonly history: readonly (ChatRequestTurn | ChatResponseTurn)[];
    
    // Proposed additions:
    readonly yieldRequested: boolean;        // Graceful stop requested
    readonly sessionResource?: Uri;          // Session resource URI
}
```

### 8.5 Session Content Providers

Extensions can provide custom session content storage:

```typescript
interface ChatSessionContentProvider {
    provideChatSessionContent(
        sessionResource: Uri,
        context: ChatSessionContentContext,
        token: CancellationToken
    ): ProviderResult<ChatSessionContent>;
}

// Register via:
chat.registerChatSessionContentProvider(
    'mySessionType', 
    provider, 
    chatParticipant, 
    capabilities
);
```

---

## 9. Token Usage Tracking & Metering

### 9.1 Usage Reporting

Token usage is reported back to extensions via `LanguageModelDataPart`:

```typescript
// CopilotLanguageModelWrapper reports usage at the end of response
progress.report(new vscode.LanguageModelDataPart(
    new TextEncoder().encode(JSON.stringify(usage)),
    CustomDataPartMimeTypes.Usage
));

// Extensions can read usage data from the response stream
interface APIUsage {
    // Token counts
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    
    // Metadata
    requestId: string;
    modelId: string;
    requestType: string;
    
    // Premium tracking
    multiplier?: number;
}

// Usage also available via ChatResult
interface ChatResultUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    modelId?: string;
    promptTokensDetail?: ChatResultPromptTokenDetail[];
}
```

### 9.2 OpenTelemetry Attributes

```typescript
// Standard GenAI attributes
GenAiAttr = {
    OPERATION: 'gen_ai.operation.name',
    SYSTEM: 'gen_ai.system',
    MODEL: 'gen_ai.model',
    MODEL_ID: 'gen_ai.model.id',
    TOKEN_TYPE: 'gen_ai.token.type',
    USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
    USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
    USAGE_REASONING_TOKENS: 'gen_ai.usage.reasoning_tokens',
    RESPONSE_ID: 'gen_ai.response.id',
    TOOL_NAME: 'gen_ai.tool.name',
    TOOL_CALL_ID: 'gen_ai.tool.call.id',
    INPUT_MESSAGES: 'gen_ai.input.messages',      // opt-in
    OUTPUT_MESSAGES: 'gen_ai.output.messages',    // opt-in
};

// Copilot-specific attributes
CopilotChatAttr = {
    LOCATION: 'copilot_chat.location',
    INTENT: 'copilot_chat.intent',
    TURN_INDEX: 'copilot_chat.turn.index',
    TURN_COUNT: 'copilot_chat.turn_count',
    TOOL_CALL_ROUND: 'copilot_chat.tool_call_round',
    API_TYPE: 'copilot_chat.api_type',
    FETCHER: 'copilot_chat.fetcher',
    DEBUG_NAME: 'copilot_chat.debug_name',
};
```

### 9.3 Quota Service

```typescript
interface IChatQuotaService {
    // Tracks premium request quotas
    // Data from copilot_internal/user endpoint
    // Used for rate limiting and premium request counting
}

interface QuotaSnapshot {
    // Per-model quota information
}

interface CopilotUserQuotaInfo {
    // User's Copilot plan quota info
}
```

### 9.4 CapturingToken for Request Logging

```typescript
class CapturingToken {
    // Used to track request metadata across IPC boundaries
    // BYOK providers restore context via _capturingTokenCorrelationId
}

// In CopilotLanguageModelWrapper:
const correlationId = (_options as { modelOptions?: OTelModelOptions })
    .modelOptions?._capturingTokenCorrelationId;
// Restore AsyncLocalStorage context for BYOC providers
```

### 9.5 Extension Blocking

```typescript
interface IBlockedExtensionService {
    isExtensionBlocked(extensionId: string): boolean;
    reportBlockedExtension(extensionId: string, retryAfter: number): void;
}

// The Copilot extension blocks extensions making too many requests
// Users see: "The extension has been temporarily blocked..."
```

---

## 10. Customization Options

### 10.1 Model Picker Customization

Users can customize which models appear in the picker:

```typescript
// Via Language Models editor:
// - Hide/show models by provider
// - Filter by capability (@provider:, @capability:, @visible:)
// - Search by name

// Via settings:
"github.copilot.chat.modelPicker.hiddenModels": ["model-id-1", "model-id-2"]
```

### 10.2 Default Model Configuration

```typescript
// Per-chat-location defaults
interface LanguageModelChatInformation {
    isDefault?: boolean | {
        [ChatLocation.Panel]?: boolean;
        [ChatLocation.Terminal]?: boolean;
        [ChatLocation.Notebook]?: boolean;
        [ChatLocation.Editor]?: boolean;
    };
}

// Setting for inline chat default
"inlineChat.defaultModel": "model-id"
```

### 10.3 Thinking Effort Configuration

```typescript
// For reasoning models, configure thinking effort:
// - None / Low / Medium / High
// - Adaptive reasoning (model decides dynamically)
// Persisted per-model across conversations
```

### 10.4 Context Configuration

```typescript
// Per-model configuration in language models config file:
{
    "version": 1,
    "models": {
        "my-model": {
            "temperature": 0.7,
            "maxTokens": 4096,
            "contextSize": 64000,
            "reasoningEffort": "high"
        }
    }
}
```

### 10.5 Chat Session Customization

```typescript
interface ChatSessionCustomizationProvider {
    provideChatSessionCustomizations(
        token: CancellationToken
    ): ProviderResult<ChatSessionCustomizationItem[]>;
}

enum ChatSessionCustomizationType {
    Agent = 1,
    Skill = 2,
    Instructions = 3,
    Hook = 4,
    Plugins = 5,
}

// The Copilot CLI customization provider supports:
// - Agents (custom agents from skills directory)
// - Skills (reusable capabilities)
// - Instructions (custom instructions files)
// - Hooks (lifecycle hooks)
// - Plugins (MCP plugins)
```

### 10.6 Prompt File Context

```typescript
// Extensions can provide prompt files that give context to the model
interface ChatPromptFileProvider {
    providePromptFiles(
        options: ChatPromptFileProviderOptions,
        token: CancellationToken
    ): ProviderResult<ChatPromptFile[]>;
}

// Also via Copilot extension API:
const copilotApi = await copilotExtension.activate();
const contextProvider = copilotApi.getContextProviderAPI('v1');
contextProvider.registerContextProvider({
    id: 'myProvider',
    selector: [{ language: 'typescript' }],
    resolver: {
        resolve: async (request, token) => {
            return [{ name: 'contextName', value: 'contextValue' }];
        },
        resolveOnTimeout: async (request, token) => {
            return [];
        }
    }
});
```

---

## 11. Security Considerations

### 11.1 API Key Storage

- API keys are stored securely via VS Code's secret storage
- Users configure keys through the Language Models editor UI
- Keys are never exposed in settings JSON

### 11.2 Extension Isolation

```typescript
// Each extension's LM requests are isolated
// Extension blocking prevents abuse
// x-onbehalf-extension-id header tracks request origin

// In CopilotLanguageModelWrapper:
const endpoint = new Proxy(_endpoint, {
    get(target, prop, receiver) {
        if (prop === 'getExtraHeaders') {
            return function() {
                return {
                    ...extraHeaders,
                    'x-onbehalf-extension-id': `${extensionId}/${extensionVersion}`,
                };
            };
        }
    }
});
```

### 11.3 Ignored Files

Extensions can mark files as hidden from language models:

```typescript
interface LanguageModelIgnoredFileProvider {
    provideFileIgnored(
        uri: Uri,
        token: CancellationToken
    ): ProviderResult<boolean>;
}

// Register via:
lm.registerIgnoredFileProvider(provider);
```

### 11.4 Responsible AI

- Built-in models have responsible AI filtering
- **No guarantee** of filtering for BYOK models (clearly documented)
- Users must ensure compliance with their chosen models

---

## 12. Complete Code Examples

### 12.1 Custom Language Model Provider Extension

```typescript
// package.json
{
    "name": "my-model-provider",
    "contributes": {
        "languageModels": [{
            "vendor": "myVendor",
            "displayName": "My Models",
            "configuration": {
                "properties": {
                    "apiKey": { "type": "string" },
                    "endpoint": { "type": "string", "default": "https://api.example.com" }
                }
            }
        }]
    },
    "enabledApiProposals": ["chatProvider"]
}

// extension.ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const provider: vscode.LanguageModelChatProvider = {
        onDidChangeLanguageModelChatInformation: new vscode.EventEmitter<void>().event,
        
        async provideLanguageModelChatInformation(options, token) {
            return [{
                id: 'myModel',
                name: 'My Custom Model',
                vendor: 'myVendor',
                version: '1.0',
                maxInputTokens: 32768,
                maxOutputTokens: 4096,
                isUserSelectable: true,
                capabilities: {
                    imageInput: false,
                    toolCalling: true,
                    editTools: ['uri', 'text'],
                },
                configurationSchema: {
                    properties: {
                        temperature: {
                            type: 'number',
                            default: 0.7,
                            description: 'Temperature',
                            group: 'navigation',
                        }
                    }
                }
            }];
        },
        
        async provideLanguageModelChatResponse(model, messages, options, progress, token) {
            // Implement your custom API call here
            const apiKey = options.modelConfiguration?.apiKey || 
                          vscode.workspace.getConfiguration().get('myModelProvider.apiKey');
            
            // Stream response
            progress.report(new vscode.LanguageModelTextPart("Hello from custom model!"));
            
            // Handle tool calls if needed
            // progress.report(new vscode.LanguageModelToolCallPart(id, name, args));
        },
        
        async provideTokenCount(model, text, token) {
            if (typeof text === 'string') {
                return Math.ceil(text.length / 4);
            }
            return 0;
        }
    };
    
    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('myVendor', provider)
    );
}
```

### 12.2 External Agent Integration via Model Proxy

```typescript
// In your extension that wants to use the model proxy:
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
    // Check if model proxy is available
    if (vscode.lm.isModelProxyAvailable) {
        try {
            const proxy = await vscode.lm.getModelProxy();
            
            // proxy.uri => http://localhost:PORT
            // proxy.key => auth nonce
            
            // Configure your external agent to connect to this proxy
            // The agent receives Copilot requests and can respond
            console.log(`Proxy available at ${proxy.uri}`);
            
            // Example: configure an MCP server
            // or start a child process that uses the proxy
        } catch (err) {
            console.error('Failed to get model proxy', err);
        }
    }
    
    // Listen for proxy availability changes
    context.subscriptions.push(
        vscode.lm.onDidChangeModelProxyAvailability(available => {
            console.log(`Model proxy available: ${available}`);
        })
    );
}
```

### 12.3 Chat Participant with Tool Calling

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Register a chat participant
    const participant = vscode.chat.createChatParticipant(
        'myExtension.myAgent',
        async (request, context, stream, token) => {
            // Access chat history
            const history = context.history;
            
            // Stream markdown response
            stream.markdown("Let me help you with that...");
            
            // Use tools
            const response = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            const [model] = response;
            
            if (model) {
                const result = await model.sendChatRequest(
                    [new vscode.LanguageModelChatMessage(
                        vscode.LanguageModelChatMessageRole.User,
                        request.prompt
                    )],
                    { tools: vscode.lm.tools },
                    token
                );
                
                // Process and stream the response
                for await (const part of result.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        stream.markdown(part.value);
                    }
                }
            }
            
            return { metadata: { custom: 'data' } };
        }
    );
    
    context.subscriptions.push(participant);
}
```

### 12.4 Context Provider Registration

```typescript
// In any extension that wants to provide context to Copilot completions:
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
    const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
    
    if (!copilotExtension) {
        return; // Copilot not installed
    }
    
    try {
        const copilotApi = await copilotExtension.activate();
        const contextProvider = copilotApi.getContextProviderAPI('v1');
        
        contextProvider.registerContextProvider({
            id: 'myCustomContext',
            selector: [{ language: 'python' }, { language: 'typescript' }],
            resolver: {
                resolve: async (request, token) => {
                    // Return context items for Copilot to use
                    return [
                        {
                            type: 'trait',
                            name: 'myCustomHint',
                            value: 'Relevant context information...',
                            importance: 50,  // 0-100
                            id: 'unique-id'
                        }
                    ];
                },
                resolveOnTimeout: async (request, token) => {
                    return [];  // Fallback if resolve takes too long
                }
            }
        });
        
        console.log('Custom context provider registered');
    } catch (error) {
        console.error('Failed to register context provider:', error);
    }
}
```

---

## Appendix: Quick Reference

### Model Provider Comparison

| Feature | Built-in BYOK | Extension Provider | Model Proxy |
|---------|--------------|-------------------|-------------|
| API Required | API Key + Copilot plan | Full extension | Extension |
| Model Selection | Pick from list | Define via code | External agent decides |
| Setup Complexity | Low | High | Medium |
| User Auth Flow | Built-in | Custom (optional) | Built-in |
| Tool Calling | Model-dependent | Configurable | Via agent |
| Vision Support | Model-dependent | Configurable | Via agent |
| Streaming | Automatic | Manual implementation | Via proxy |
| Token Counting | Built-in | Custom | N/A |

### Key VS Code APIs Map

```
┌──────────────────────────────────────────────────┐
│  VS Code API Summary for Copilot Integration      │
├──────────────────────────────────────────────────┤
│                                                    │
│  lm.selectChatModels()          — Pick a model     │
│  lm.onDidChangeChatModels()     — Model changes    │
│  lm.registerLanguageModel-      — Add model        │
│     ChatProvider()                 provider        │
│  lm.registerTool()              — Register tool    │
│  lm.registerToolDefinition()    — Tool with model  │
│                                scope               │
│  lm.invokeTool()                — Call a tool      │
│  lm.getModelProxy()             — Get proxy URI    │
│  lm.registerLanguageModel-      — Add proxy        │
│     ProxyProvider()                provider        │
│  lm.registerIgnoredFileProvider()— Hide files      │
│  lm.embeddingModels             — List embeddings  │
│  lm.registerEmbeddingsProvider()— Add embeddings   │
│                                                    │
│  chat.createChatParticipant()   — Chat participant │
│  chat.createDynamicChat-        — Runtime           │
│     Participant()                  participant     │
│  chat.registerChatSession-      — Session content  │
│     ContentProvider()             provider         │
│                                                    │
└──────────────────────────────────────────────────┘
```

### Resources

- **BYOK Documentation:** https://code.visualstudio.com/docs/copilot/customization/language-models
- **VS Code API:** https://code.visualstudio.com/api/references/vscode-api
- **Extension Samples:** https://github.com/microsoft/vscode-extension-samples
- **Copilot Extension API:** Via `GitHub.copilot` extension exports
- **Model Provider Extensions:** Search `tag:language-models` on Marketplace
