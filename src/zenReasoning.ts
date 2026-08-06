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
 * Mirrors the reasoning history conversion currently used by the provider.
 *
 * The initial implementation deliberately reads only streamed thinking text.
 * VS Code persists completed thinking in metadata, which this implementation
 * does not yet restore.
 */
export function extractZenReasoning(
  parts: readonly ZenReasoningHistoryPart[],
): string {
  let reasoning = '';

  for (const part of parts) {
    if (part.kind === 'thinking') {
      reasoning += Array.isArray(part.value) ? part.value.join('') : part.value;
    } else {
      reasoning += new TextDecoder().decode(part.data);
    }
  }

  return reasoning;
}
