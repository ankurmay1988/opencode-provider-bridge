import * as vscode from 'vscode';

import type { ModelMessage, ToolSet } from 'ai';
import { ModelsDevModel, ModelsDevProvider } from './opencodeConfig.js';
import { jsonSchema, streamText, tool } from 'ai';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { log } from './logger.js';

const REASONING_CONTENT_MIME = 'application/vnd.opencode-bridge.reasoning';

const SAFE_SCHEMA_KEYS = new Set([
  'type', 'properties', 'items', 'required', 'description',
  'enum', 'format', 'default',
  'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'additionalProperties',
  'anyOf', 'oneOf', 'allOf', '$ref', 'not',
  'title', 'examples', 'pattern',
]);

function simplifySchema(schema: unknown, label = ''): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const rec = schema as Record<string, unknown>;
  const rawKeys = Object.keys(rec);

  // If the schema uses anyOf/oneOf/allOf, preserve them recursively
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (rec[combinator] && Array.isArray(rec[combinator])) {
      return {
        [combinator]: (rec[combinator] as unknown[]).map((sub, i) =>
          simplifySchema(sub, `${label}.${combinator}[${i}]`),
        ),
      };
    }
  }

  if (rec.type === 'object' || rec.type === undefined) {
    const out: Record<string, unknown> = { type: 'object' };
    for (const key of Object.keys(rec)) {
      if (!SAFE_SCHEMA_KEYS.has(key)) {continue;}
      const val = rec[key];
      if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
        const cleaned: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(val as Record<string, unknown>)) {
          cleaned[propName] = simplifySchema(propSchema, `${label}.${propName}`);
        }
        out.properties = cleaned;
      } else if (key === 'items' && val && typeof val === 'object') {
        out.items = simplifySchema(val, `${label}.items`);
      } else {
        out[key] = val;
      }
    }

    const stripped = rawKeys.filter(k => !SAFE_SCHEMA_KEYS.has(k));
    if (stripped.length > 0) {
      log(`[opencode-provider-bridge] schema ${label || '<root>'}: stripped ${stripped.join(', ')}`, 'debug');
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec)) {
    if (SAFE_SCHEMA_KEYS.has(key)) {
      const val = rec[key];
      if (key === 'items' && val && typeof val === 'object') {
        out.items = simplifySchema(val, `${label}.items`);
      } else {
        out[key] = val;
      }
    }
  }

  const stripped = rawKeys.filter(k => !SAFE_SCHEMA_KEYS.has(k));
  if (stripped.length > 0) {
    log(`[opencode-provider-bridge] schema ${label || '<root>'}: stripped ${stripped.join(', ')}`, 'debug');
  }
  return out;
}

/**
 * Extract plain text from an AI SDK ToolResult for rendering in the chat UI.
 * ToolResult.content is typically an array of { type: 'text', text: '...' } parts.
 */
function extractTextFromToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') {return '';}
  const rec = result as Record<string, unknown>;
  if (typeof rec.text === 'string') {return rec.text;}
  if (Array.isArray(rec.content)) {
    return rec.content
      .map((part: unknown) => {
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') {return p.text;}
          if (p.type === 'text' && typeof p.value === 'string') {return p.value;}
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export class OpencodeModelProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  lastUsage: { prompt: number; completion: number } | null = null;
  private aiProvider: ReturnType<typeof createOpenAICompatible> | null = null;

  /** Cache of simplified tool input schemas keyed by tool name. */
  private toolSchemaCache = new Map<string, Record<string, unknown>>();

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
    this.aiProvider = null;
  }

  fireChange(): void {
    this.onDidChangeEmitter.fire();
  }

  private getProvider() {
    if (this.aiProvider) {return this.aiProvider;}

    const knownApis: Record<string, string> = {
      opencode: 'https://opencode.ai/zen/v1',
      'opencode-go': 'https://opencode.ai/go/v1',
    };
    const baseUrl = this.providerInfo.api || knownApis[this.providerInfo.id] || `https://api.${this.providerInfo.id}.com/v1`;

    this.aiProvider = createOpenAICompatible({
      name: this.providerInfo.id,
      baseURL: baseUrl.replace(/\/$/, ''),
      apiKey: this.apiKey,
    });
    return this.aiProvider;
  }

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

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let currentReasoning = '';
    let reasoningEnded = false;

    const coreMessages = this.toModelMessages(messages);
    log(`[opencode-provider-bridge] Converted ${coreMessages.length} messages for model=${model.id}`, 'debug');

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

    const provider = this.getProvider();
    const languageModel = provider(model.id);

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
            report(new vscode.LanguageModelThinkingPart('', undefined, { vscode_reasoning_done: true }));
            break;

          case 'tool-call':
            hasToolCall = true;
            log(`[opencode-provider-bridge] TOOL_OUT: ${part.toolName} id=${part.toolCallId}`, 'debug');
            report(new vscode.LanguageModelToolCallPart(part.toolCallId, part.toolName, part.input as Record<string, unknown>));
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

      // Report final aggregated reasoning for multi-turn context.
      // The real-time chunks above already rendered the thinking content;
      // this provides the complete text as data for subsequent turns.
      if (currentReasoning && !reasoningEnded) {
        report(new vscode.LanguageModelThinkingPart(
          '',
          undefined,
          { _completeThinking: currentReasoning, vscode_reasoning_done: true },
        ));
      } else if (currentReasoning && reasoningEnded) {
        // reasoning-end already emitted vscode_reasoning_done.
        // Only emit _completeThinking as data to avoid double-triggering the UI.
        report(new vscode.LanguageModelDataPart(
          new TextEncoder().encode(JSON.stringify({
            _completeThinking: currentReasoning,
          })),
          REASONING_CONTENT_MIME,
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
      let reasoningContent = '';

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          log(`[opencode-provider-bridge] convert: ToolCall name=${part.name} id=${part.callId}`, 'debug');
          toolCallParts.push({
            toolCallId: part.callId,
            toolName: part.name,
            input: part.input,
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          log(`[opencode-provider-bridge] convert: ToolResult id=${part.callId}`, 'debug');
          toolCallId = part.callId;
          toolResultName = (part as any).name ?? undefined;
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
          if (part.mimeType === REASONING_CONTENT_MIME) {
            const decoded = new TextDecoder().decode(part.data);
            reasoningContent += decoded;
          }
        } else if (part instanceof vscode.LanguageModelThinkingPart) {
          reasoningContent += part.value ?? '';
        }
      }

      if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') });
        }
        if (toolCallId && toolResultContent !== undefined) {
          result.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId,
                toolName: toolResultName ?? 'unknown',
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
