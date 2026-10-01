import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const OPEN_CODE_SESSION_HEADER = 'x-opencode-session';

const OPEN_CODE_SESSION_PROVIDERS = new Set(['opencode', 'opencode-go']);
const requestContext = new AsyncLocalStorage<OpenCodeSessionContext | undefined>();

export interface OpenCodeSessionContext {
  readonly providerId: string;
  readonly sessionId: string;
}

interface MessageLike {
  readonly role: unknown;
  readonly content: readonly unknown[];
}

export function isOpenCodeSessionProvider(providerId: string): boolean {
  return OPEN_CODE_SESSION_PROVIDERS.has(providerId);
}

/**
 * Returns text parts from the first user message only. If that message has no
 * usable text (for example, an attachment-only prompt), later user messages
 * are deliberately not used as a substitute for the conversation's opener.
 */
export function extractFirstUserMessageText(
  messages: readonly MessageLike[],
  userRole: unknown,
  getText: (part: unknown) => string | undefined,
): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === userRole);
  if (!firstUserMessage) {return undefined;}

  const text = firstUserMessage.content
    .map(getText)
    .filter((part): part is string => typeof part === 'string')
    .join('\n');

  return text.trim().length > 0 ? text : undefined;
}

/**
 * Prefer VS Code's internal conversation ID, falling back to a deterministic
 * OpenCode-shaped ID based on the first user message. The hash is namespaced
 * by provider so Zen and Go do not share an ID for the same opening text.
 */
export function resolveOpenCodeSessionId(
  providerId: string,
  conversationId: unknown,
  firstUserMessageText: string | undefined,
): string | undefined {
  if (!isOpenCodeSessionProvider(providerId)) {return undefined;}

  const candidate = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (candidate && !/[\u0000-\u001f\u007f-\u009f]/u.test(candidate)) {
    return candidate;
  }

  if (typeof firstUserMessageText !== 'string' || firstUserMessageText.trim().length === 0) {
    return undefined;
  }

  const digest = createHash('sha256')
    .update('opencode-provider-bridge:session-id:v1\0')
    .update(providerId)
    .update('\0')
    .update(firstUserMessageText)
    .digest('hex');

  return `ses_${digest.slice(0, 26)}`;
}

/** Run asynchronous request work with its own immutable session context. */
export function runWithOpenCodeSessionContext<T>(
  context: OpenCodeSessionContext | undefined,
  operation: () => T,
): T {
  return requestContext.run(context, operation);
}

/**
 * Wraps fetch to add the current request's session header for Zen and Go only.
 * The effective Request/init headers are copied, never mutated in place.
 */
export function createOpenCodeSessionFetch(
  originalFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async function openCodeSessionFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const context = requestContext.getStore();
    if (!context || !context.sessionId || !isOpenCodeSessionProvider(context.providerId)) {
      return originalFetch(input, init);
    }

    const requestHeaders = input instanceof Request ? input.headers : undefined;
    const headers = new Headers(init?.headers ?? requestHeaders);
    headers.set(OPEN_CODE_SESSION_HEADER, context.sessionId);

    return originalFetch(input, { ...init, headers });
  };
}
