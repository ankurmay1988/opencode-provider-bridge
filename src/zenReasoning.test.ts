import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

import {
  extractZenReasoning,
  withThinkingMetadata,
  ZEN_REASONING_CONTENT_MIME,
} from './zenReasoning.js';

async function serializeZenAssistant(
  content: unknown,
  toolResult = false,
): Promise<Record<string, unknown>> {
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      id: 'response',
      created: 0,
      model: 'zen-thinker',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } });
  };
  const zen = createOpenAICompatible({
    name: 'opencode',
    apiKey: 'test-key',
    baseURL: 'https://example.invalid/v1',
    fetch,
  });

  await generateText({
    model: zen('zen-thinker'),
    messages: [
      { role: 'assistant', content },
      ...(toolResult ? [{
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read_file',
          output: { type: 'text', value: 'file contents' },
        }],
      }] : []),
      { role: 'user', content: 'continue' },
    ] as any,
  });

  return requests[0].messages[0];
}

test('restores completed Zen reasoning from VS Code thinking history', () => {
  const reasoning = 'inspect project files before editing';

  const restored = extractZenReasoning([
    {
      kind: 'thinking',
      value: '',
      metadata: { _completeThinking: reasoning, vscode_reasoning_done: true },
    },
  ]);

  assert.equal(restored, reasoning);
});

test('assigns complete reasoning metadata after constructing a thinking part', () => {
  class RuntimeThinkingPart {
    metadata?: Record<string, unknown>;

    constructor(
      readonly value: string,
      _id?: string,
      _ignoredMetadata?: Record<string, unknown>,
    ) {}
  }

  const part = new RuntimeThinkingPart('', undefined, { _completeThinking: 'lost by runtime' });
  assert.equal(part.metadata, undefined);

  withThinkingMetadata(part, { _completeThinking: 'preserved reasoning' });
  assert.deepEqual(part.metadata, { _completeThinking: 'preserved reasoning' });
});

test('uses completed reasoning once after streamed deltas', () => {
  assert.equal(extractZenReasoning([
    { kind: 'thinking', value: 'streamed prefix ' },
    { kind: 'thinking', value: '', metadata: { _completeThinking: 'complete reasoning' } },
  ]), 'complete reasoning');
});

test('preserves several consecutive assistant reasoning messages', () => {
  const first = extractZenReasoning([
    { kind: 'thinking', value: '', metadata: { _completeThinking: 'first reasoning' } },
  ]);
  const second = extractZenReasoning([
    { kind: 'thinking', value: '', metadata: { _completeThinking: 'second reasoning' } },
  ]);

  assert.deepEqual([first, second], ['first reasoning', 'second reasoning']);
});

test('restores legacy complete reasoning DataPart without using raw JSON as reasoning', () => {
  assert.equal(extractZenReasoning([
    {
      kind: 'data',
      mimeType: ZEN_REASONING_CONTENT_MIME,
      data: new TextEncoder().encode(JSON.stringify({ _completeThinking: 'legacy reasoning' })),
    },
  ]), 'legacy reasoning');
});

test('does not invent reasoning for absent, empty, or malformed history', () => {
  assert.equal(extractZenReasoning([]), '');
  assert.equal(extractZenReasoning([{ kind: 'thinking', value: '', metadata: { _completeThinking: '' } }]), '');
  assert.equal(extractZenReasoning([
    {
      kind: 'data',
      mimeType: ZEN_REASONING_CONTENT_MIME,
      data: new TextEncoder().encode('{not json'),
    },
  ]), '');
});

test('keeps normal Anthropic and Google streamed thinking content unchanged', () => {
  const streamed = [
    { kind: 'thinking' as const, value: 'step one ' },
    { kind: 'thinking' as const, value: ['step ', 'two'] },
  ];

  assert.equal(extractZenReasoning(streamed), 'step one step two');
});

test('serializes restored reasoning_content for a second Zen request', async () => {
  const reasoning = extractZenReasoning([
    { kind: 'thinking', value: '', metadata: { _completeThinking: 'saved reasoning' } },
  ]);
  const assistant = await serializeZenAssistant([
    { type: 'reasoning', text: reasoning },
    { type: 'text', text: 'first answer' },
  ]);

  assert.equal(assistant.reasoning_content, 'saved reasoning');
  assert.equal(assistant.content, 'first answer');
});

test('serializes reasoning-only Zen assistant messages', async () => {
  const assistant = await serializeZenAssistant([
    { type: 'reasoning', text: 'reasoning only' },
  ]);

  assert.equal(assistant.reasoning_content, 'reasoning only');
  assert.equal(assistant.content, '');
});

test('serializes reasoning with Zen tool calls', async () => {
  const assistant = await serializeZenAssistant([
    { type: 'reasoning', text: 'choose tool' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'README.md' } },
  ], true);

  assert.equal(assistant.reasoning_content, 'choose tool');
  assert.equal(assistant.content, null);
  assert.deepEqual(assistant.tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' },
  }]);
});

test('does not serialize empty reasoning_content for ordinary models', async () => {
  const assistant = await serializeZenAssistant([
    { type: 'text', text: 'ordinary answer' },
  ]);

  assert.equal('reasoning_content' in assistant, false);
  assert.equal(assistant.content, 'ordinary answer');
});
