# VS Code Copilot Extensibility — Complete Analysis

> **Repository:** https://github.com/microsoft/vscode  
> **Focus:** Copilot-related extension APIs, proposed APIs, and integration points  
> **Analysis Date:** May 14, 2026

---

## Table of Contents

1. [Overview of VS Code's Copilot Extensibility Model](#1-overview)
2. [Stable Public APIs](#2-stable-public-apis)
3. [Proposed APIs (enabledApiProposals)](#3-proposed-apis)
4. [Language Model Provider System](#4-language-model-provider-system)
5. [Chat Participant System](#5-chat-participant-system)
6. [Tool Registration & Invocation](#6-tool-registration--invocation)
7. [External Agent Integration (Model Proxy)](#7-external-agent-integration)
8. [Embeddings System](#8-embeddings-system)
9. [Ignored Files & Security](#9-ignored-files--security)
10. [Extension Host Architecture](#10-extension-host-architecture)
11. [Complete API Surface Reference](#11-complete-api-surface-reference)

---

## 1. Overview

VS Code provides a comprehensive extensibility model for Copilot integration through:

1. **`vscode.d.ts` (stable)** — The published, stable API surface
2. **`vscode.proposed.*.d.ts` (proposed)** — In-development APIs behind `enabledApiProposals`
3. **Internal `ILanguageModelChatProvider` (main thread)** — The workbench-level provider contract
4. **Extension Contribution Points** — `package.json` declarations for chat participants and language models

### Architecture Layers

```
┌──────────────────────────────────────────────────────────┐
│                    Extension (extHost)                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ExtHostLanguageModels    — LM provider registry    │  │
│  │  ExtHostChatAgents2       — Chat participant Mgmt   │  │
│  │  ExtHostLanguageModelTools — Tool registration      │  │
│  │  ExtHostEmbeddings        — Embeddings providers    │  │
│  │  ExtHostChatSessions      — Chat session providers  │  │
│  └──────────────────┬─────────────────────────────────┘  │
│                     │ RPC (JSON-RPC)                      │
├─────────────────────▼────────────────────────────────────┤
│                   Main Thread                             │
│  ┌────────────────────────────────────────────────────┐  │
│  │  MainThreadLanguageModels   — LM provider host      │  │
│  │  MainThreadChatAgents2      — Chat agent host       │  │
│  │  LanguageModelsService      — Provider aggregation  │  │
│  │  LanguageModelToolsService  — Tool orchestration    │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Stable Public APIs

### 2.1 `lm` namespace — Language Model Access

```typescript
namespace lm {
    // Select available chat models
    export function selectChatModels(
        selector?: LanguageModelChatSelector
    ): Thenable<LanguageModelChat[]>;
    
    // Listen for model changes
    export function onDidChangeChatModels(
        listener: (e: void) => any
    ): Disposable;
}
```

The `LanguageModelChat` object returned provides:

```typescript
interface LanguageModelChat {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly version: string;
    readonly maxInputTokens: number;
    
    sendChatRequest(
        messages: LanguageModelChatMessage[],
        options: LanguageModelChatRequestOptions,
        token: CancellationToken
    ): Thenable<LanguageModelChatResponse>;
    
    provideTokenCount(
        text: string | LanguageModelChatMessage
    ): Thenable<number>;
    
    // Proposed extensions:
    readonly capabilities?: {
        supportsToolCalling: boolean;
        supportsImageToText: boolean;
        editToolsHint?: readonly string[];
    };
}
```

### 2.2 `chat` namespace — Chat Participants

```typescript
namespace chat {
    export function createChatParticipant(
        id: string,
        handler: ChatExtendedRequestHandler
    ): ChatParticipant;
}
```

The `ChatParticipant` interface:

```typescript
interface ChatParticipant {
    iconPath?: IconPath | ThemeIcon;
    description?: string;
    fullName?: string;
    isSticky?: boolean;
    supportIssueReporting?: boolean;
    participantVariableProvider?: { ... };
    
    onDidPerformAction: Event<ChatUserActionEvent>;
    onDidChangePauseState: Event<ChatParticipantPauseStateEvent>;
    onDidReceiveFeedback: Event<ChatFeedbackEvent>;
}
```

### 2.3 Chat Response Parts

```typescript
class ChatResponseMarkdownPart { value: MarkdownString }
class ChatResponseAnchorPart { value: Uri | Location }
class ChatResponseCommandButtonPart { value: Command }
class ChatResponseDetectedParticipantPart { ... }
class ChatResponseProgressPart2 { value: string }
class ChatResponseWarningPart { ... }
class ChatResponseReferencePart { ... }

// Extended parts (proposed):
class ChatResponseTextEditPart { ... }
class ChatResponseNotebookEditPart { ... }
class ChatResponseWorkspaceEditPart { ... }
class ChatResponseConfirmationPart { ... }
class ChatResponseCodeCitationPart { ... }
class ChatToolInvocationPart { ... }
class ChatResponseMultiDiffPart { ... }
class ChatResponseThinkingProgressPart { ... }
```

---

## 3. Proposed APIs

All proposed APIs require the extension to declare them in `package.json`:

```json
{
    "enabledApiProposals": [
        "chatParticipantAdditions",
        "chatParticipantPrivate",
        "chatProvider",
        "languageModelProxy",
        "languageModelCapabilities",
        "embeddings",
        "chatSessionsProvider"
    ]
}
```

### 3.1 `chatProvider` — Language Model Chat Provider

**File:** `vscode.proposed.chatProvider.d.ts` (Version 5)

Register a custom language model provider:

```typescript
namespace lm {
    export function registerLanguageModelChatProvider<T extends LanguageModelChatInformation>(
        vendor: string,
        provider: LanguageModelChatProvider<T>
    ): Disposable;
}

interface LanguageModelChatProvider<T extends LanguageModelChatInformation> {
    onDidChangeLanguageModelChatInformation?: Event<void>;
    
    provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        token: CancellationToken
    ): ProviderResult<T[]>;
    
    provideLanguageModelChatResponse(
        model: T,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart2>,
        token: CancellationToken
    ): Thenable<void>;
}

interface LanguageModelChatInformation {
    id: string;
    name: string;
    family?: string;
    vendor: string;
    version?: string;
    maxInputTokens: number;
    maxOutputTokens?: number;
    isDefault?: boolean | { [K in ChatLocation]?: boolean };
    isUserSelectable?: boolean;
    requiresAuthorization?: true | { label: string };
    capabilities: LanguageModelChatCapabilities;
    configurationSchema?: LanguageModelConfigurationSchema;
    pricing?: string;
    multiplierNumeric?: number;
    priceCategory?: string;
    tooltip?: string | MarkdownString;
    statusIcon?: ThemeIcon;
    targetChatSessionType?: string;
}
```

### 3.2 `chatParticipantAdditions` — Extended Chat Parts

**File:** `vscode.proposed.chatParticipantAdditions.d.ts` (Version 3)

Extends chat participants with:
- Extended response parts (TextEdit, NotebookEdit, WorkspaceEdit, etc.)
- `ChatResultUsage` — Token usage tracking
- Tool invocation parts
- Copy/Insert/Apply action tracking
- Confirmation support

### 3.3 `chatParticipantPrivate` — Private Extensions

**File:** `vscode.proposed.chatParticipantPrivate.d.ts` (Version 15)

Key capabilities:

```typescript
// Dynamic chat participants (runtime creation)
namespace chat {
    export function createDynamicChatParticipant(
        id: string,
        dynamicProps: DynamicChatParticipantProps,
        handler: ChatExtendedRequestHandler
    ): ChatParticipant;
}

interface DynamicChatParticipantProps {
    name: string;
    publisherName: string;
    description?: string;
    fullName?: string;
}

// Participant detection
namespace chat {
    export function registerChatParticipantDetectionProvider(
        provider: ChatParticipantDetectionProvider
    ): Disposable;
}

// Ignored file provider
namespace lm {
    export function registerIgnoredFileProvider(
        provider: LanguageModelIgnoredFileProvider
    ): Disposable;
}

// Chat session disposal events
namespace chat {
    export const onDidDisposeChatSession: Event<string>;
}
```

### 3.4 `languageModelProxy` — External Model Proxy

**File:** `vscode.proposed.languageModelProxy.d.ts`

```typescript
namespace lm {
    export function getModelProxy(): Thenable<LanguageModelProxy>;
    
    export function registerLanguageModelProxyProvider(
        provider: LanguageModelProxyProvider
    ): Disposable;
}

interface LanguageModelProxy extends Disposable {
    readonly uri: Uri;   // Local server URI
    readonly key: string; // Auth key for the proxy
}

interface LanguageModelProxyProvider {
    provideModelProxy(
        forExtensionId: string,
        token: CancellationToken
    ): ProviderResult<LanguageModelProxy | undefined>;
}
```

### 3.5 `embeddings` — Embeddings Support

```typescript
namespace lm {
    export const embeddingModels: string[];
    export function onDidChangeEmbeddingModels(listener): Disposable;
    export function registerEmbeddingsProvider(
        model: string,
        provider: EmbeddingsProvider
    ): Disposable;
    export function computeEmbeddings(
        model: string,
        input: string | string[],
        token?: CancellationToken
    ): Thenable<Embedding[]>;
}
```

### 3.6 `chatSessionsProvider` — Chat Session Providers

```typescript
namespace chat {
    export function registerChatSessionContentProvider(
        scheme: string,
        provider: ChatSessionContentProvider,
        chatParticipant: ChatParticipant,
        capabilities?: ChatSessionCapabilities
    ): Disposable;
}
```

---

## 4. Language Model Provider System

### 4.1 Extension Contribution Point

In `package.json`, extensions declare language model providers:

```json
{
    "contributes": {
        "languageModels": [{
            "vendor": "myVendor",
            "displayName": "My Models",
            "configuration": {
                "properties": {
                    "apiKey": {
                        "type": "string",
                        "description": "API key"
                    }
                }
            },
            "when": "config.myExtension.enabled"
        }]
    }
}
```

### 4.2 Internal Provider Interface (Main Thread)

```typescript
interface ILanguageModelChatProvider {
    readonly onDidChange: Event<void>;
    
    provideLanguageModelChatInfo(
        options: ILanguageModelChatInfoOptions,
        token: CancellationToken
    ): Promise<ILanguageModelChatMetadataAndIdentifier[]>;
    
    sendChatRequest(
        modelId: string,
        messages: IChatMessage[],
        from: ExtensionIdentifier | undefined,
        options: ILanguageModelChatRequestOptions,
        token: CancellationToken
    ): Promise<ILanguageModelChatResponse>;
    
    provideTokenCount(
        modelId: string,
        message: string | IChatMessage,
        token: CancellationToken
    ): Promise<number>;
}
```

### 4.3 LanguageModelsService

The central service (`languageModels.ts`) that:

- Manages vendor registrations
- Resolves model configurations
- Routes chat requests to the correct provider
- Handles model selection via `selectLanguageModels(selector)`
- Manages per-model configuration (user settings)
- Tracks model visibility and control

### 4.4 Model Configuration System

Users can configure language models via a JSON schema-based configuration:

```typescript
interface LanguageModelConfigurationSchema {
    properties?: {
        [key: string]: Record<string, any> & {
            enumItemLabels?: string[];
            group?: string; // 'navigation' for primary actions
        };
    };
}
```

---

## 5. Chat Participant System

### 5.1 Extension Contribution Point

```json
{
    "contributes": {
        "chatParticipants": [{
            "id": "myExtension.myParticipant",
            "name": "My Participant",
            "description": "Does amazing things",
            "fullName": "My Extension Participant",
            " iconPath": "...",
            "commands": [{
                "name": "hello",
                "description": "Say hello",
                "disambiguation": [{
                    "category": "greeting",
                    "description": "Greeting commands",
                    "examples": ["hello", "hi"]
                }]
            }],
            "when": "config.myExtension.enabled"
        }]
    }
}
```

### 5.2 ExtHostChatAgents2 (Extension Host)

Key responsibilities:

- **Registration**: `createChatAgent()`, `createDynamicChatAgent()`
- **Detection**: `registerChatParticipantDetectionProvider()`
- **Session Customization**: `registerChatSessionCustomizationProvider()`
- **Hook/Plugin/Skill Providers**: Various customization providers
- **RPC Bridge**: Forwards requests between extension host and main thread

### 5.3 Chat Request Handler Type

```typescript
type ChatExtendedRequestHandler = (
    request: ChatRequest,
    context: ChatContext,
    response: ChatResponseStream,
    token: CancellationToken
) => ProviderResult<ChatResult | void>;
```

### 5.4 ChatResult with Usage

```typescript
interface ChatResult {
    metadata?: Record<string, any>;
    nextQuestion?: { prompt: string; participant?: string; command?: string };
    details?: string;
    usage?: ChatResultUsage;  // Token usage
}

interface ChatResultUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    modelId?: string;
    promptTokensDetail?: ChatResultPromptTokenDetail[];
}
```

---

## 6. Tool Registration & Invocation

### 6.1 Tool Registration

Tools can be registered in two ways:

**Via `package.json` contributions:**
```json
{
    "contributes": {
        "languageModelTools": [{
            "name": "myTool",
            "description": "Description of my tool",
            "icon": "...",
            "inputSchema": { ... JSON Schema ... },
            "canBeReferencedInPrompt": true,
            "canSupportModel": ["model-id-1", "model-id-2"]
        }]
    }
}
```

**Via API:**
```typescript
namespace lm {
    export function registerTool<T>(
        name: string,
        tool: LanguageModelTool<T>
    ): Disposable;
    
    export function registerToolDefinition<T>(
        definition: LanguageModelToolDefinition,
        tool: LanguageModelTool<T>
    ): Disposable;
}
```

### 6.2 Tool Interface

```typescript
interface LanguageModelTool<T> {
    invoke(
        options: LanguageModelToolInvocationOptions<T>,
        token: CancellationToken
    ): ProviderResult<LanguageModelToolResult | LanguageModelToolStreamResult>;
    
    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<T>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation | undefined>;
}

interface LanguageModelToolInvocationOptions<T> {
    input: T;
    toolId?: string;
    toolDefinition?: LanguageModelToolDefinition;
    model?: LanguageModelChatInformation;
}
```

### 6.3 Internal Tools Service

```typescript
interface ILanguageModelToolsService {
    readonly vscodeToolSet: ToolSet;
    readonly executeToolSet: ToolSet;
    readonly readToolSet: ToolSet;
    readonly agentToolSet: ToolSet;
    readonly onDidChangeTools: Event<void>;
    
    registerToolData(toolData: IToolData): IDisposable;
    registerToolImplementation(id: string, tool: IToolImpl): IDisposable;
    registerTool(toolData: IToolData, tool: IToolImpl): IDisposable;
    getTools(model): Iterable<IToolData>;
}
```

---

## 7. External Agent Integration (Model Proxy)

### 7.1 LanguageModelProxy Architecture

The proxy system allows extensions to get a local HTTP server URI and key to integrate external agents:

```
┌──────────────┐       ┌──────────────────┐       ┌─────────────────┐
│  Extension    │──────▶│  Copilot Chat     │──────▶│  LM Proxy       │
│  (e.g. Agent) │       │  Extension        │       │  (HTTP Server)  │
└──────────────┘       └──────────────────┘       └────────┬────────┘
                                                            │
                                                   ┌────────▼────────┐
                                                   │  External Model  │
                                                   │  / Agent Server  │
                                                   └─────────────────┘
```

### 7.2 Internal Implementation

```typescript
// modelProxyProvider.ts
class LanguageModelProxyProvider implements vscode.LanguageModelProxyProvider {
    async provideModelProxy(forExtensionId: string, token: CancellationToken) {
        const server = this.instantiationService.createInstance(OpenAILanguageModelServer);
        await server.start();
        return new OpenAILanguageModelProxy(server);
    }
}

class OpenAILanguageModelProxy extends Disposable implements vscode.LanguageModelProxy {
    public readonly uri: Uri;   // http://localhost:{port}
    public readonly key: string; // Nonce for authentication
    
    constructor(runningServer: OpenAILanguageModelServer) {
        const config = runningServer.getConfig();
        this.uri = URI.parse(`http://localhost:${config.port}`);
        this.key = config.nonce;
    }
}
```

### 7.3 Proxy Enablement

The proxy is enabled when the user has a Copilot token with codexAgentEnabled:

```typescript
class LanguageModelProxyContrib extends Disposable implements IExtensionContribution {
    constructor(
        @IAuthenticationService authenticationService,
        @IConfigurationService configurationService,
    ) {
        // Enable proxy when conditions are met
        const enableProxy = token && (
            token.codexAgentEnabled || 
            configurationService.getNonExtensionConfig('chat.experimental.codex.enabled')
        );
        // Register/unregister accordingly
    }
}
```

---

## 8. Embeddings System

### 8.1 API Surface

```typescript
namespace lm {
    export const embeddingModels: string[];
    export function onDidChangeEmbeddingModels(listener): Disposable;
    
    export function registerEmbeddingsProvider(
        embeddingsModel: string,
        provider: EmbeddingsProvider
    ): Disposable;
    
    export function computeEmbeddings(
        embeddingsModel: string,
        input: string | string[],
        token?: CancellationToken
    ): Thenable<Embedding[]>;
}
```

### 8.2 Embeddings Provider Interface

```typescript
interface EmbeddingsProvider {
    provideEmbeddings(
        input: string[],
        token: CancellationToken
    ): Thenable<Embedding[][]>;
}

interface Embedding {
    readonly vector: number[];  // Float32Array-like
}
```

---

## 9. Ignored Files & Security

### 9.1 Ignored File Provider

Extensions can control which files are visible to language models:

```typescript
namespace lm {
    export function registerIgnoredFileProvider(
        provider: LanguageModelIgnoredFileProvider
    ): Disposable;
}

interface LanguageModelIgnoredFileProvider {
    provideFileIgnored(
        uri: Uri,
        token: CancellationToken
    ): ProviderResult<boolean>;
}
```

### 9.2 Extension Blocking

The Copilot extension can temporarily block extensions that make too many requests:

```typescript
interface IBlockedExtensionService {
    isExtensionBlocked(extensionId: string): boolean;
    reportBlockedExtension(extensionId: string, retryAfter: number): void;
}
```

---

## 10. Extension Host Architecture

### 10.1 Key Classes (Extension Host Side)

| Class | File | Role |
|-------|------|------|
| `ExtHostLanguageModels` | `extHostLanguageModels.ts` | LM provider registry + proxy + ignored files |
| `ExtHostChatAgents2` | `extHostChatAgents2.ts` | Chat participant registry + handlers |
| `ExtHostLanguageModelTools` | `extHostLanguageModelTools.ts` | Tool registration + invocation |
| `ExtHostEmbeddings` | `extHostEmbeddings.ts` | Embeddings providers |
| `ExtHostChatSessions` | `extHostChatSessions.ts` | Session content providers |

### 10.2 Key Classes (Main Thread Side)

| Class | File | Role |
|-------|------|------|
| `MainThreadLanguageModels` | `mainThreadLanguageModels.ts` | LM provider RPC bridge |
| `MainThreadChatAgents2` | `mainThreadChatAgents2.ts` | Chat agent RPC bridge |
| `LanguageModelsService` | `languageModels.ts` | Central LM service |
| `LanguageModelToolsService` | `languageModelToolsService.ts` | Central tool service |

### 10.3 RPC Protocol

Communication between extension host and main thread uses defined proxy interfaces:

```typescript
interface MainThreadLanguageModelsShape {
    $registerLanguageModelProvider(vendor: string): void;
    $onLMProviderChange(vendor: string): void;
    $unregisterProvider(vendor: string): void;
    $tryStartChatRequest(...): Promise<void>;
    $reportResponsePart(...): Promise<void>;
    $reportResponseDone(...): Promise<void>;
    $selectChatModels(selector): Promise<string[]>;
    $countTokens(modelId, value, token): Promise<number>;
    $fileIsIgnored(uri, token): Promise<boolean>;
    $registerFileIgnoreProvider(handle): void;
    $unregisterFileIgnoreProvider(handle): void;
}
```

---

## 11. Complete API Surface Reference

### 11.1 Proposed API Files (src/vscode-dts/)

| File | Version | Key Offerings |
|------|---------|---------------|
| `vscode.proposed.chatProvider.d.ts` | 5 | `LanguageModelChatProvider`, `LanguageModelChatInformation`, configuration schemas |
| `vscode.proposed.chatParticipantAdditions.d.ts` | 3 | Extended response parts, `ChatResultUsage`, tool invocation, actions |
| `vscode.proposed.chatParticipantPrivate.d.ts` | 15 | Dynamic participants, detection, error details, LM proxy, ignored files |
| `vscode.proposed.languageModelCapabilities.d.ts` | — | Model capabilities (tool calling, vision, edit tools) |
| `vscode.proposed.languageModelThinkingPart.d.ts` | 1 | `LanguageModelThinkingPart`, `LanguageModelChatMessage2` |
| `vscode.proposed.languageModelPricing.d.ts` | — | Pricing info on `LanguageModelChatInformation` |
| `vscode.proposed.languageModelToolSupportsModel.d.ts` | 1 | Tool definitions with model support, `invokeTool` by info |
| `vscode.proposed.languageModelProxy.d.ts` | — | Model proxy for external agents |

### 11.2 Extension Contribution Points

| Contribution Point | Used For |
|-------------------|----------|
| `chatParticipants` | Declare chat participants with commands |
| `languageModels` | Declare language model vendors |
| `languageModelTools` | Declare tools available to LMs |
| `chatSessions` | Declare chat session types |

### 11.3 Key Enums

```typescript
enum ChatLocation { Panel = 1, Terminal = 2, Notebook = 3, Editor = 4 }
enum ChatCopyKind { Action = 1, Toolbar = 2 }
enum ChatErrorLevel { Info = 0, Warning = 1, Error = 2 }
enum ChatSessionStatus { Unknown = 0, Active = 1, Closed = 2 }
```

---

## Appendix: API Proposal Registration Map

All proposal IDs and their mapping from `extensionsApiProposals.ts`:

```
chatProvider              → vscode.proposed.chatProvider.d.ts (v5)
chatParticipantAdditions  → vscode.proposed.chatParticipantAdditions.d.ts (v3)
chatParticipantPrivate    → vscode.proposed.chatParticipantPrivate.d.ts (v15)
chatHooks                 → vscode.proposed.chatHooks.d.ts (v6)
chatInputNotification     → vscode.proposed.chatInputNotification.d.ts
chatOutputRenderer        → vscode.proposed.chatOutputRenderer.d.ts
chatSessionsProvider      → vscode.proposed.chatSessionsProvider.d.ts
embeddings                → vscode.proposed.embeddings.d.ts
languageModelCapabilities → vscode.proposed.languageModelCapabilities.d.ts
languageModelPricing      → vscode.proposed.languageModelPricing.d.ts
languageModelProxy        → vscode.proposed.languageModelProxy.d.ts
languageModelThinkingPart → vscode.proposed.languageModelThinkingPart.d.ts (v1)
languageModelToolSupportsModel → vscode.proposed.languageModelToolSupportsModel.d.ts (v1)
```
