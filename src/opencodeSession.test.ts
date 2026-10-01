import {
  OPEN_CODE_SESSION_HEADER,
  createOpenCodeSessionFetch,
  extractFirstUserMessageText,
  isOpenCodeSessionProvider,
  resolveOpenCodeSessionId,
  runWithOpenCodeSessionContext,
} from './opencodeSession.js';

import assert from 'node:assert/strict';
import test from 'node:test';

test('prefers a non-empty VS Code conversation ID over the message hash', () => {
  assert.equal(
    resolveOpenCodeSessionId('opencode', '  vscode-conversation-123  ', 'first prompt'),
    'vscode-conversation-123',
  );
});

test('falls back to the opener hash for empty or unsafe VS Code IDs', () => {
  const fallback = resolveOpenCodeSessionId('opencode', undefined, 'first prompt');

  assert.equal(resolveOpenCodeSessionId('opencode', '', 'first prompt'), fallback);
  assert.equal(resolveOpenCodeSessionId('opencode', ' \n ', 'first prompt'), fallback);
  assert.equal(resolveOpenCodeSessionId('opencode', 'invalid\r\nheader', 'first prompt'), fallback);
});

test('creates a deterministic, provider-specific fallback ID', () => {
  const zenId = resolveOpenCodeSessionId('opencode', undefined, 'open the project');
  const repeatedZenId = resolveOpenCodeSessionId('opencode', undefined, 'open the project');
  const goId = resolveOpenCodeSessionId('opencode-go', undefined, 'open the project');
  const differentPromptId = resolveOpenCodeSessionId('opencode', undefined, 'inspect the project');

  assert.equal(zenId, repeatedZenId);
  assert.notEqual(zenId, goId);
  assert.notEqual(zenId, differentPromptId);
  assert.match(zenId ?? '', /^ses_[0-9a-f]{26}$/u);
});

test('does not resolve an ID when the first user message has no usable text', () => {
  for (const text of [undefined, '', ' \n\t ']) {
    assert.equal(resolveOpenCodeSessionId('opencode-go', undefined, text), undefined);
  }
});

test('uses only text parts from the earliest user message', () => {
  const text = extractFirstUserMessageText(
    [
      { role: 'assistant', content: [{ text: 'ignore assistant' }] },
      { role: 'user', content: [{ text: 'first' }, { attachment: true }, { text: 'message' }] },
      { role: 'user', content: [{ text: 'later user message' }] },
    ],
    'user',
    (part) => (part as { text?: string }).text,
  );

  assert.equal(text, 'first\nmessage');
});

test('returns no opener text when no user message exists', () => {
  assert.equal(extractFirstUserMessageText(
    [{ role: 'assistant', content: [{ text: 'assistant only' }] }],
    'user',
    (part) => (part as { text?: string }).text,
  ), undefined);
});

test('does not substitute a later text message for an attachment-only opener', () => {
  const text = extractFirstUserMessageText(
    [
      { role: 'user', content: [{ attachment: true }] },
      { role: 'user', content: [{ text: 'later message' }] },
    ],
    'user',
    (part) => (part as { text?: string }).text,
  );

  assert.equal(text, undefined);
  assert.equal(resolveOpenCodeSessionId('opencode', undefined, text), undefined);
});

test('limits session-header handling to the exact Zen and Go provider IDs', () => {
  assert.equal(isOpenCodeSessionProvider('opencode'), true);
  assert.equal(isOpenCodeSessionProvider('opencode-go'), true);
  assert.equal(isOpenCodeSessionProvider('opencode-custom'), false);
  assert.equal(resolveOpenCodeSessionId('anthropic', 'conversation', 'prompt'), undefined);
});

test('adds the session header for Zen and Go while preserving and overriding headers', async () => {
  for (const providerId of ['opencode', 'opencode-go']) {
    let sentHeaders: Headers | undefined;
    const fetchWithSession = createOpenCodeSessionFetch(async (_input, init) => {
      sentHeaders = new Headers(init?.headers);
      return new Response('ok');
    });
    const originalHeaders = new Headers({
      Authorization: 'Bearer secret',
      'x-trace-id': 'trace-123',
      [OPEN_CODE_SESSION_HEADER]: 'stale-session',
    });

    await runWithOpenCodeSessionContext(
      { providerId, sessionId: `${providerId}-session` },
      () => fetchWithSession('https://example.invalid/chat', { headers: originalHeaders }),
    );

    assert.equal(sentHeaders?.get(OPEN_CODE_SESSION_HEADER), `${providerId}-session`);
    assert.equal(sentHeaders?.get('authorization'), 'Bearer secret');
    assert.equal(sentHeaders?.get('x-trace-id'), 'trace-123');
    assert.equal(originalHeaders.get(OPEN_CODE_SESSION_HEADER), 'stale-session');
  }
});

test('preserves headers from a Request input when init does not replace them', async () => {
  let sentHeaders: Headers | undefined;
  const fetchWithSession = createOpenCodeSessionFetch(async (_input, init) => {
    sentHeaders = new Headers(init?.headers);
    return new Response('ok');
  });
  const request = new Request('https://example.invalid/chat', {
    headers: { Authorization: 'Bearer from-request', 'x-trace-id': 'request-trace' },
  });

  await runWithOpenCodeSessionContext(
    { providerId: 'opencode', sessionId: 'request-session' },
    () => fetchWithSession(request),
  );

  assert.equal(sentHeaders?.get(OPEN_CODE_SESSION_HEADER), 'request-session');
  assert.equal(sentHeaders?.get('authorization'), 'Bearer from-request');
  assert.equal(sentHeaders?.get('x-trace-id'), 'request-trace');
});

test('passes through requests without a target session context unchanged', async () => {
  let capturedInput: Parameters<typeof globalThis.fetch>[0] | undefined;
  let capturedInit: Parameters<typeof globalThis.fetch>[1] | undefined;
  const fetchWithSession = createOpenCodeSessionFetch(async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return new Response('ok');
  });
  const input = 'https://example.invalid/chat';
  const init = { method: 'POST', headers: { Authorization: 'Bearer secret' } };

  for (const context of [undefined, { providerId: 'anthropic', sessionId: 'must-not-leak' }]) {
    await runWithOpenCodeSessionContext(context, () => fetchWithSession(input, init));
    assert.strictEqual(capturedInput, input);
    assert.strictEqual(capturedInit, init);
  }

  await runWithOpenCodeSessionContext(
    { providerId: 'opencode', sessionId: 'outer-session' },
    () => runWithOpenCodeSessionContext(undefined, () => fetchWithSession(input, init)),
  );
  assert.strictEqual(capturedInput, input);
  assert.strictEqual(capturedInit, init);
});

test('keeps overlapping Zen and Go requests isolated', async () => {
  const captured: Array<{ label: string; sessionId: string | null }> = [];
  let releaseFetches!: () => void;
  const bothFetchesStarted = new Promise<void>((resolve) => { releaseFetches = resolve; });
  const fetchWithSession = createOpenCodeSessionFetch(async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const label = new URL(url).searchParams.get('label') ?? '';
    captured.push({
      label,
      sessionId: new Headers(init?.headers).get(OPEN_CODE_SESSION_HEADER),
    });
    if (captured.length === 2) {releaseFetches();}
    await bothFetchesStarted;
    return new Response('ok');
  });

  let releaseRequests!: () => void;
  const bothRequestsStarted = new Promise<void>((resolve) => { releaseRequests = resolve; });
  let requestCount = 0;
  const send = (providerId: string, sessionId: string, label: string) =>
    runWithOpenCodeSessionContext({ providerId, sessionId }, async () => {
      requestCount++;
      if (requestCount === 2) {releaseRequests();}
      await bothRequestsStarted;
      return fetchWithSession(`https://example.invalid/chat?label=${label}`);
    });

  await Promise.all([
    send('opencode', 'zen-session', 'zen'),
    send('opencode-go', 'go-session', 'go'),
  ]);

  assert.deepEqual(captured.sort((a, b) => a.label.localeCompare(b.label)), [
    { label: 'go', sessionId: 'go-session' },
    { label: 'zen', sessionId: 'zen-session' },
  ]);
});