// =============================================================================
// provider.ts  —  Per-Provider LM Implementation
// =============================================================================
//
// WHAT THIS FILE DOES
//   This file implements OpencodeModelProvider, which wraps a SINGLE
//   opencode-configured provider (e.g. Anthropic, OpenAI, Google) and
//   implements the vscode.LanguageModelChatProvider interface.
//
//   While extension.ts: BridgeProvider is a router that delegates to the
//   right sub-provider, THIS class actually talks to the provider's API.
//
// =============================================================================
// VS CODE RESPONSE STREAM PROCESSING (from extChatEndpoint.ts source)
// =============================================================================
//
// VS Code's Copilot Chat extension consumes our streamed response via
// ExtensionContributedChatEndpoint.makeChatRequest2() (source:
// extensions/copilot/src/platform/endpoint/vscode-node/extChatEndpoint.ts).
// It iterates over response.stream and handles these chunk types:
//
//   LanguageModelTextPart       → appended to response text
//   LanguageModelToolCallPart   → forwarded as tool call to agent loop
//   LanguageModelDataPart:
//     mime = 'usage'            → parsed as APIUsage, populates context widget
//     mime = 'statefulMarker'   → stateful conversation markers
//     mime = 'contextManagement'→ context management responses
//   LanguageModelThinkingPart   → forwarded as thinking/reasoning display
//
// The stream result is returned as:
//   { type: 'success', text, usage, resolvedModel }
//
// If text is empty AND no tools were called, returns Unknown error.
// If an exception is thrown, returns Failed with error message.
//
// References:
//   - extChatEndpoint.ts L188-L258: response stream consumption
//   - extChatEndpoint.ts L97-L111: success/unknown/failed response shapes
//   - extChatEndpoint.ts L276-L371: convertToApiChatMessage (message conversion)
//   - PR #315394: usage DataPart for BYOK context widget
//   - PR #314801: alternative usage reporting approach
//
// =============================================================================
// RESPONSE PART TYPES — what we can report to VS Code
// =============================================================================
//
//   LanguageModelTextPart(text)
//     → Visible text in chat UI. Persisted in content field of assistant msg.
//
//   LanguageModelToolCallPart(callId, name, input)
//     → Tool invocation. VS Code executes the tool and sends result back
//       as LanguageModelToolResultPart in the next request.
//
//   LanguageModelDataPart(data, mimeType)
//     → Arbitrary metadata. Two recognized mime types:
//       'usage' → token counts (PR #315394, VS Code 1.120+)
//       Other MIME types → ignored by Copilot Chat (stripped from history)
//
//   LanguageModelThinkingPart(value, id, metadata)
//     → Reasoning/thinking content. VS Code 1.119+ renders this natively
//       in the Chat UI with collapse/expand. Preserved in conversation
//       history. NOT merged into content text — clean separation.
//       Not yet in @types/vscode (added locally via vscode.thinking.d.ts).
//
// =============================================================================
// REASONING CONTENT HANDLING (DeepSeek, Qwen, Kimi, etc.)
// =============================================================================
//
// PROBLEM: Reasoning models return `reasoning_content` alongside `content`
// in the SSE delta. On subsequent requests, the API requires the field to
// be present on every assistant message created during a thinking turn.
//
// LAYER 1 — Streaming (processLine):
//   `reasoning_content` is buffered in currentReasoning.
//
// LAYER 2 — API payload (convertMessages):
//   `entry.reasoning_content = reasoningContent || ''` ensures the field
//   EXISTS on every assistant message. Reasoning models require the field
//   to be present — having it with the actual text or empty string is
//   accepted. Blanket empty string on ALL messages (including non-reasoning
//   Copilot history) was found to degrade tool calling quality, so we only
//   set it when we have actual reasoning text from the stream.
//
// LanguageModelThinkingPart (Step 7):
//   Reported when available (VS Code 1.119+ runtime). Renders thinking/
//   reasoning content in the Chat UI with native collapse/expand support.
//   Preserved in conversation history. Detected in convertMessages() and
//   value extracted for the reasoning_content API payload field.
//   Reference: extChatEndpoint.ts, issue #262994
//
// References:
//   - DeepSeek Thinking Mode: https://api-docs.deepseek.com/guides/thinking_mode
//   - OpenCode issue #24130 / PR #24146: interleaved reasoning_content
//   - Community ext: pushpender-singh-ap/opencode-zen-chat-provider-reasoning
//   - Hermes Agent fix: https://github.com/NousResearch/hermes-agent/issues/17212
//
// =============================================================================
// MESSAGE CONVERSION (VS Code format → OpenAI format)
// =============================================================================
//
// VS Code sends conversation history as LanguageModelChatRequestMessage[].
// Each message has role (User/Assistant) and content (array of typed parts).
//
// We convert to OpenAI-compatible format in convertMessages():
//
//   VS Code Part               → OpenAI JSON field
//   ───────────────────────────────────────────────────
//   LanguageModelTextPart      → { role: "user"|"assistant", content: "..." }
//   LanguageModelToolCallPart  → tool_calls[] on assistant messages
//   LanguageModelToolResultPart→ { role: "tool", tool_call_id, content }
//   LanguageModelDataPart      → ignored (metadata only)
//   LanguageModelThinkingPart  → value extracted to reasoning_content field
//
// Tool calls are kept SEPARATE from text content (in tool_calls array),
// which prevents context pollution. Reasoning content from ThinkingPart
// is extracted and injected as reasoning_content field in the payload.
//
// References:
//   - extChatEndpoint.ts L276-L371: VS Code's own convertToApiChatMessage
//   - extChatEndpoint.ts L188-L220: stream consumption + usage/thinking handling
//
// =============================================================================

import * as vscode from 'vscode';
import { ModelsDevProvider, ModelsDevModel } from './opencodeConfig.js';
import { log } from './logger.js';

/**
 * Custom MIME type for preserving reasoning_content across VS Code conversation turns.
 *
 * VS Code's LanguageModelChatProvider API has no native ReasoningPart type.
 * However, LanguageModelDataPart IS preserved in conversation history. By
 * wrapping reasoning_content text as a DataPart with this MIME type, it
 * survives the round trip through VS Code.
 *
 * On the next request, convertMessages() detects this MIME type, decodes the
 * reasoning text, and injects it as a `reasoning_content` field in the API
 * payload — satisfying DeepSeek et al. requirement that the field be present.
 *
 * Solution inspired by:
 *   - pushpender-singh-ap/opencode-zen-chat-provider-reasoning (Marketplace)
 *     https://github.com/pushpender-singh-ap/opencode-zen-chat-provider-reasoning
 *   - DeepSeek Thinking Mode API docs
 *     https://api-docs.deepseek.com/guides/thinking_mode
 *   - OpenCode issue #24130 / PR #24146 (interleaved: reasoning_content)
 *     https://github.com/anomalyco/opencode/issues/24130
 */
const REASONING_CONTENT_MIME = 'application/vnd.opencode-bridge.reasoning';

/**
 * Ensure a tool's input schema is a valid JSON Schema with type: "object".
 * Some providers (DeepSeek, etc.) reject null schemas or schemas without
 * an explicit type. VS Code sometimes passes null or schemaless defs.
 */
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const rec = schema as Record<string, unknown>;
    if (rec.type === 'object' || rec.type === undefined) {
      return { type: 'object', properties: rec.properties ?? {}, ...rec };
    }
    return rec; // already has a type, pass through
  }
  return { type: 'object', properties: {} };
}

/**
 * Wraps a single opencode provider and speaks OpenAI-compatible HTTP API.
 *
 * CONSTRUCTOR RECEIVES (from extension.ts → getProviders()):
 *   providerInfo  → { id:"anthropic", name:"Anthropic", api:"https://...", models:{...} }
 *   apiKey        → the secret key (e.g. "sk-ant-...")
 *   enabledModels → Map of modelId → model metadata (only tool-capable models)
 */
export class OpencodeModelProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  /** Token usage from the most recent API response, if reported. */
  lastUsage: { prompt: number; completion: number } | null = null;

  /** reasoning_content accumulated during the current response stream. */
  private currentReasoning = '';

  constructor(
    readonly providerInfo: ModelsDevProvider,
    private apiKey: string,
    private enabledModels: Map<string, ModelsDevModel>,
  ) {}

  /** Check if an API key is configured for this provider. */
  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** Set or update the API key at runtime (e.g. after interactive prompt). */
  setApiKey(key: string): void {
    this.apiKey = key;
  }

  fireChange(): void {
    this.onDidChangeEmitter.fire();
  }

  // -----------------------------------------------------------------------
  // Model Catalogue (used by BridgeProvider)
  // -----------------------------------------------------------------------
  //
  // VS Code calls this indirectly: BridgeProvider.provideLanguageModelChatInformation()
  // → BridgeProvider.collectModels() → OpencodeModelProvider.provideLanguageModelChatInformation()
  //
  // We just return our enabled models as vscode.LanguageModelChatInformation objects.
  // BridgeProvider will prefix the IDs and merge them with other providers.

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const [modelId, modelMeta] of this.enabledModels) {
      models.push({
        id: modelId,
        name: modelMeta.name || modelId,
        family: modelMeta.family || 'unknown',
        version: '1.0.0',
        maxInputTokens: modelMeta.limit?.context ?? 128000,
        maxOutputTokens: modelMeta.limit?.output ?? 4096,
        capabilities: {
          imageInput: !!(modelMeta.modalities?.input?.includes('image')),
          toolCalling: modelMeta.tool_call ?? false,
        },
      });
    }

    return models;
  }

  // -----------------------------------------------------------------------
  // Chat Completion — the core execution path
  // -----------------------------------------------------------------------
  //
  // Called from BridgeProvider when a user sends a chat message.
  // This is where the actual AI request happens.
  //
  // STEP-BY-STEP:
  //   1. Build the API URL from provider config
  //   2. Convert VS Code messages → OpenAI message format
  //   3. Build the request body with tools/tool_choice
  //   4. POST to the provider's /chat/completions endpoint
  //   5. Stream the SSE response back to VS Code
  //
  // PARAMETERS (from VS Code, via BridgeProvider):
  //   model     → the LanguageModelChatInformation the user picked
  //   messages  → full conversation history (user + assistant messages)
  //   options   → contains tools[] (function definitions from VS Code)
  //               and toolMode (auto/required/None)
  //   progress  → call progress.report() to stream chunks
  //   token     → cancellation signal

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    this.currentReasoning = '';

    // --- Step 1: Determine the API endpoint ---
    // Priority: model-specific URL (from SDK registry) > provider-level
    // override > known opencode managed providers > guess from provider ID.
    const knownApis: Record<string, string> = {
      opencode: 'https://opencode.ai/zen/v1',
      'opencode-go': 'https://opencode.ai/go/v1',
    };
    const modelMeta = this.enabledModels.get(model.id);
    const hasReasoning = modelMeta?.reasoning ?? false;
    const baseUrl = modelMeta?.apiUrl || this.providerInfo.api || knownApis[this.providerInfo.id] || `https://api.${this.providerInfo.id}.com/v1`;
    const apiUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    // --- Step 2: Build the request body ---
    // We always request streaming (stream: true) so VS Code can show
    // the response as it arrives.
    const convertedMessages = this.convertMessages(messages, hasReasoning);
    log(`[opencode-provider-bridge] Prepared payload: ${convertedMessages.length} messages, model=${model.id}, hasReasoning=${hasReasoning}`);

    const body: Record<string, unknown> = {
      model: model.id,
      messages: convertedMessages,
      stream: true,
    };

    // If VS Code provided tool definitions (functions), include them
    if (options.tools?.length) {
      log(`[opencode-provider-bridge] Building ${options.tools.length} tool(s) for API request`);
      body.tools = options.tools.map((tool) => {
        const params = sanitizeSchema(tool.inputSchema);
        const props = (params as any)?.properties;
        const propKeys = props ? Object.keys(props).join(',') : 'none';
        log(`[opencode-provider-bridge] Tool: ${tool.name} schema_type=${(params as any)?.type} props=[${propKeys}]`);
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters: params,
          },
        };
      });
    }

    // tool_choice controls whether the model MUST use a tool:
    //   'auto'     → model decides when to use tools
    //   'required' → model must use a tool on every turn
    if (options.toolMode !== undefined) {
      body.tool_choice =
        options.toolMode === vscode.LanguageModelChatToolMode.Required
          ? 'required'
          : 'auto';
    }

    // --- Step 3: Wire up cancellation ---
    // If the user clicks "Stop" in VS Code Chat, we abort the fetch.
    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    // --- Step 4: Make the HTTP request ---
    log(`[opencode-provider-bridge] POST ${apiUrl} (hasReasoning=${hasReasoning})`);
    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (err) {
      // Network error, DNS failure, timeout, etc.
      throw new vscode.LanguageModelError(
        `Request to ${this.providerInfo.name} failed: ${(err as Error).message}`,
      );
    }

    // --- Step 5: Handle HTTP errors ---
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new vscode.LanguageModelError(
        `${this.providerInfo.name} returned ${response.status}: ${errorText}`,
      );
    }

    // --- Step 6: Stream the SSE response ---
    await this.streamResponse(response, progress);

    // --- Step 7: Report reasoning content as LanguageModelThinkingPart ---
    // VS Code 1.119+ has a native LanguageModelThinkingPart that renders
    // thinking/reasoning content in the Chat UI with collapse/expand support.
    // It's preserved in conversation history without polluting the visible
    // text content. On the next request, convertMessages() detects these
    // parts and extracts value for the reasoning_content API payload field.
    // Reference: extChatEndpoint.ts, issue #262994
    if (this.currentReasoning && typeof vscode.LanguageModelThinkingPart === 'function') {
      progress.report(new vscode.LanguageModelThinkingPart(this.currentReasoning, undefined, {}));
    }

    // --- Step 8: Report token usage for the Context Window widget ---
    // VS Code 1.120.0+ (PR #315394 merged) reads usage from a LanguageModelDataPart
    // with mime type 'usage'. This populates the context window progress bar and
    // token counts in the Chat UI for BYOK/third-party providers.
    // Reference: https://github.com/microsoft/vscode/pull/315394
    if (this.lastUsage) {
      progress.report(new vscode.LanguageModelDataPart(
        new TextEncoder().encode(JSON.stringify({
          prompt_tokens: this.lastUsage.prompt,
          completion_tokens: this.lastUsage.completion,
          total_tokens: this.lastUsage.prompt + this.lastUsage.completion,
        })),
        'usage',
      ));
    }
  }

  // -----------------------------------------------------------------------
  // Token Count
  // -----------------------------------------------------------------------
  //
  // Simple character-based heuristic. A real implementation would use
  // the provider's tokenizer API for accurate counts.

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const serialized = typeof text === 'string' ? text : JSON.stringify(text.content);
    return Math.max(1, Math.ceil(serialized.length / 4));
  }

  // -----------------------------------------------------------------------
  // SSE (Server-Sent Events) Stream Parser
  // -----------------------------------------------------------------------

  /**
   * Read the HTTP response body as a stream of SSE chunks.
   *
   * SSE format from OpenAI-compatible APIs:
   *   data: {"id":"...","choices":[{"delta":{"content":"Hello"},"index":0}]}
   *   data: {"id":"...","choices":[{"delta":{"content":" world"},"index":0}]}
   *   data: [DONE]
   *
   * HOW SSE PARSING WORKS:
   *   1. Read binary chunks from the fetch Response body
   *   2. Decode to text, append to a buffer
   *   3. Split buffer by newlines → each line is one SSE event
   *   4. Keep any incomplete trailing data in the buffer for next read
   *   5. Process each complete line
   *
   * This handles chunk boundary issues where a single SSE message
   * might be split across two TCP packets.
   */
  private async streamResponse(
    response: Response,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode the binary chunk, preserving incomplete multi-byte characters
      buffer += decoder.decode(value, { stream: true });

      // Split on newlines — each line is one SSE "data:" event
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';   // keep incomplete line for next read

      for (const line of lines) {
        this.processLine(line.trim(), progress);
      }
    }
  }

  /**
   * Parse a single SSE data line and report its content to VS Code.
   *
   * LINE FORMATS WE HANDLE:
   *   data: {"choices":[{"delta":{"content":"Hello"}}]}    → text chunk
   *   data: {"choices":[{"delta":{"tool_calls":[{...}}]}]}  → tool call
   *   data: [DONE]                                          → stream end
   *
   * Each "delta" represents the NEXT PIECE of the response.
   * We report it immediately to progress.report() so VS Code
   * can update the UI in real-time.
   */
  private processLine(
    line: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (!line || !line.startsWith('data: ')) return;

    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return;

    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }

    // --- Capture token usage (sent in the final chunk by most providers) ---
    if (chunk.usage) {
      this.lastUsage = {
        prompt: chunk.usage.prompt_tokens ?? chunk.usage.input_tokens ?? 0,
        completion: chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    if (!delta) return;

    // --- Text content ---
    // Report to VS Code as visible text. reasoning_content is NOT reported
    // as text — it's captured separately and re-injected as a proper field
    // on the next request (required by some thinking-mode APIs).
    if (delta.content) {
      progress.report(new vscode.LanguageModelTextPart(delta.content));
    }
    // --- Log delta structure for debugging (all keys present) ---
    const nonContentKeys = Object.keys(delta).filter(k => k !== 'content');
    if (nonContentKeys.length > 0 && !delta.tool_calls) {
      log(`[opencode-provider-bridge] Delta keys: ${nonContentKeys.join(',')} len=${(delta.content ?? '').length}`);
    }
    // --- Reasoning content (DeepSeek, Qwen, Kimi, etc.) ---
    // Buffered for the `reasoning_content` field in the API payload
    // (required by thinking-mode APIs, see convertMessages).
    // NOT reported as visible text — doing so floods the conversation
    // history with thinking tokens, degrading tool-calling quality.
    if (delta.reasoning_content) {
      if (!this.currentReasoning) {
        log(`[opencode-provider-bridge] Captured reasoning_content in stream (first chunk)`);
      }
      this.currentReasoning += delta.reasoning_content;
    }

    // --- Tool/function calls ---
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          const argsStr = tc.function.arguments ?? '';
          log(`[opencode-provider-bridge] TOOL_OUT: ${tc.function.name} id=${tc.id} args_len=${argsStr.length} args_preview="${argsStr.slice(0, 120)}"`);
          if (argsStr.length > 0) {
            try {
              const args = JSON.parse(argsStr);
              progress.report(
                new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args),
              );
            } catch (parseErr) {
              log(`[opencode-provider-bridge] Tool call parse error: ${(parseErr as Error).message}`);
            }
          } else {
            // Empty args — report anyway so VS Code knows the model tried
            progress.report(
              new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, {}),
            );
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Message Format Converter
  // -----------------------------------------------------------------------
  //
  // VS Code uses its own message format (LanguageModelChatRequestMessage),
  // but the provider's API expects the OpenAI chat completions format.
  //
  // VS CODE FORMAT (input):
  //   [
  //     { role: User, content: [TextPart("Hello"), ToolResultPart(...)] },
  //     { role: Assistant, content: [TextPart("Hi"), ToolCallPart(...)] }
  //   ]
  //
  // OPENAI FORMAT (output):
  //   [
  //     { role: "user", content: "Hello" },
  //     { role: "tool", tool_call_id: "call_xxx", content: "..." },
  //     { role: "assistant", content: "Hi", tool_calls: [...] }
  //   ]
  //
  // KEY MAPPINGS:
  //   TextPart.value          → content string
  //   ToolCallPart            → tool_calls array on assistant messages
  //   ToolResultPart          → tool message with tool_call_id
  //
  // NOTE: VS Code groups user messages as one LanguageModelChatRequestMessage
  // that can contain multiple parts. We flatten them here.

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    hasReasoning: boolean,
  ): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    for (const msg of messages) {
      const textParts: string[] = [];
      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];
      let toolCallId: string | undefined;
      let toolResultContent: string | undefined;
      let reasoningContent = '';

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          // Assistant messages with function calls
          log(`[opencode-provider-bridge] convert: ToolCall name=${part.name} id=${part.callId}`);
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          // Results of previous tool calls (fed back as context)
          log(`[opencode-provider-bridge] convert: ToolResult id=${part.callId}`);
          toolCallId = part.callId;
          toolResultContent = part.content
            .filter((c): c is vscode.LanguageModelTextPart =>
              c instanceof vscode.LanguageModelTextPart,
            )
            .map((c) => c.value)
            .join('\n');
        } else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === REASONING_CONTENT_MIME) {
          // Legacy fallback: reasoning content as DataPart (pre-1.119 VS Code).
          const decoded = new TextDecoder().decode(part.data);
          reasoningContent = (reasoningContent ?? '') + decoded;
        } else if (part instanceof vscode.LanguageModelThinkingPart) {
          // Extract reasoning content reported via Step 7 (VS Code 1.119+).
          // Preserved in conversation history without polluting content text.
          reasoningContent = (reasoningContent ?? '') + (part.value ?? '');
        }
      }

      // --- User role messages ---
      if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') });
        }
        // Tool results are sent as separate "tool" role messages
        if (toolCallId && toolResultContent !== undefined) {
          result.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: toolResultContent,
          });
        }
      }
      // --- Assistant role messages ---
      else {
        const c = textParts.join('\n');
        const entry: Record<string, unknown> = {
          role: 'assistant',
          content: c,
        };
        log(`[opencode-provider-bridge] convertMessages: assistant msg, content_len=${c.length}, reasoning_len=${reasoningContent.length}`);

        // DeepSeek reasoning mode requires `reasoning_content` on assistant
        // messages from thinking turns. We inject actual reasoning text when
        // available (from LanguageModelThinkingPart), and empty string as a
        // fallback to prevent 400 errors. This empty-string fallback is safe
        // because DeepSeek only validates the field on messages IT produced,
        // not on unrelated history from other providers.
        // Reference: https://api-docs.deepseek.com/guides/thinking_mode
        entry.reasoning_content = reasoningContent || '';

        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
        }
        result.push(entry);
      }
    }

    return result;
  }
}
