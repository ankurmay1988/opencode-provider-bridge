// =============================================================================
// verboseFetch.ts  —  SSE stream logging fetch wrapper
// =============================================================================
//
// Wraps globalThis.fetch to log HTTP request/response details and raw SSE
// stream data at debug level. Only active when logLevel is set to "debug".
// The wrapper is transparent — all responses pass through unchanged.
// =============================================================================

import { log } from './logger.js';

/**
 * Wraps a fetch function to log HTTP request URLs and raw SSE stream data
 * at debug log level.
 */
export function createVerboseFetch(originalFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async function verboseFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const url = (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) ?? '';
    log(`[opencode-provider-bridge] FETCH ${init?.method ?? 'GET'} ${url}`, 'debug');

    if (init?.body) {
      const bodyStr = typeof init.body === 'string'
        ? init.body
        : '[non-string body]';
      const truncated = bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + '\n... [truncated]' : bodyStr;
      log(`[opencode-provider-bridge] REQUEST BODY:\n${truncated}`, 'debug');
    }

    const response = await originalFetch(input, init);

    if (!response.ok || !response.body) {return response;}
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') && !url.includes('/chat/completions')) {return response;}

    log(`[opencode-provider-bridge] RESPONSE status=${response.status} ct=${contentType}`, 'debug');

    if (!contentType.includes('text/event-stream')) {return response;}

    // Stream interception for SSE logging
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    (async () => {
      let buffer = '';
      let eventCount = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.close();
            log(`[opencode-provider-bridge] SSE stream ended (${eventCount} events)`, 'debug');
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            if (!part.trim()) {continue;}
            eventCount++;
            const dataLines = part.split('\n')
              .filter(l => l.startsWith('data: '))
              .map(l => {
                const data = l.slice(6);
                return data.length > 500 ? data.slice(0, 500) + '... [truncated]' : data;
              });
            for (const data of dataLines) {
              log(`[opencode-provider-bridge] SSE #${eventCount}: ${data}`, 'debug');
            }
          }
          await writer.write(value);
        }
      } catch (err) {
        log(`[opencode-provider-bridge] SSE stream error: ${err}`, 'error');
        try { await writer.abort(err); } catch { /* ignore */ }
      }
    })();

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
