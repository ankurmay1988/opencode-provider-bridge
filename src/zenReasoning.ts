import type { ModelMessage } from 'ai';

export const ZEN_REASONING_CONTENT_MIME = 'application/vnd.opencode-bridge.reasoning';

/**
 * DeepSeek thinking mode requires reasoning_content on every replayed
 * assistant message, including VS Code's synthetic tool-call history.
 * Provider metadata makes the OpenAI-compatible serializer emit the required
 * empty field without altering messages that contain real reasoning.
 */
export function ensureZenReasoningContent(
  messages: readonly ModelMessage[],
  enabled: boolean,
): ModelMessage[] {
  if (!enabled) {
    return [...messages];
  }

  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return message;
    }

    const content = Array.isArray(message.content)
      ? [...message.content]
      : message.content
        ? [{ type: 'text' as const, text: message.content }]
        : [];

    if (content.some((part) => part.type === 'reasoning')) {
      return { ...message, content } as ModelMessage;
    }

    return {
      ...message,
      content,
      providerOptions: {
        ...message.providerOptions,
        openaiCompatible: {
          ...message.providerOptions?.openaiCompatible,
          reasoning_content: '',
        },
      },
    } as ModelMessage;
  });
}

export type ThinkingPartWithMetadata = {
  metadata?: Record<string, unknown>;
};

/**
 * VS Code's runtime ignores a third LanguageModelThinkingPart constructor
 * argument. Metadata must be assigned after the part is created.
 */
export function withThinkingMetadata<T extends ThinkingPartWithMetadata>(
  part: T,
  metadata: Record<string, unknown>,
): T {
  part.metadata = metadata;
  return part;
}

export type ZenReasoningHistoryPart =
  | {
    kind: 'thinking';
    value: string | string[];
    metadata?: Record<string, unknown>;
  }
  | {
    kind: 'data';
    mimeType: string;
    data: Uint8Array;
  };

/**
 * Restores Zen reasoning from VS Code assistant history without duplicating
 * streaming deltas when VS Code has the completed-thinking marker.
 */
export function extractZenReasoning(
  parts: readonly ZenReasoningHistoryPart[],
): string {
  let streamedReasoning = '';
  let completedReasoning: string | undefined;

  for (const part of parts) {
    if (part.kind === 'thinking') {
      const complete = part.metadata?._completeThinking;
      if (typeof complete === 'string' && complete.length > 0) {
        completedReasoning = complete;
      } else {
        streamedReasoning += Array.isArray(part.value) ? part.value.join('') : part.value;
      }
      continue;
    }

    if (part.mimeType !== ZEN_REASONING_CONTENT_MIME) {continue;}

    try {
      const complete = JSON.parse(new TextDecoder().decode(part.data))._completeThinking;
      if (typeof complete === 'string' && complete.length > 0) {
        completedReasoning = complete;
      }
    } catch {
      // Ignore malformed legacy DataParts. They are not valid reasoning.
    }
  }

  return completedReasoning ?? streamedReasoning;
}
