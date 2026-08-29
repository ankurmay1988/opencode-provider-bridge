import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

import {
  ensureZenReasoningContent,
  extractZenReasoning,
  isDeepSeekModel,
  withThinkingMetadata,
  ZEN_REASONING_CONTENT_MIME,
} from './zenReasoning.js';

async function serializeZenAssistant(
  content: unknown,
  toolResult = false,
  providerOptions?: Record<string, unknown>,
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
      { role: 'assistant', content, providerOptions },
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

test('adds empty reasoning_content to DeepSeek assistant tool history', async () => {
  const messages = ensureZenReasoningContent([{
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'read_file',
      input: { path: 'README.md' },
    }],
  } as any], true);

  const assistant = await serializeZenAssistant(
    messages[0].content,
    true,
    messages[0].providerOptions,
  );

  assert.equal(assistant.reasoning_content, '');
  assert.deepEqual(assistant.tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' },
  }]);
});

test('preserves real Zen reasoning and leaves other providers unchanged', async () => {
  const original = [{
    role: 'assistant',
    content: [
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'real reasoning' },
    ],
  }] as any;

  const zen = ensureZenReasoningContent(original, true);
  const ordinary = ensureZenReasoningContent([{
    role: 'assistant',
    content: 'answer',
  } as any], false);

  assert.deepEqual(zen, original);
  assert.equal(ordinary[0].content, 'answer');
});

test('identifies DeepSeek models across providers and discovery tiers', () => {
  // Zen (OpenCode provider) serving a DeepSeek model via SDK discovery.
  assert.equal(isDeepSeekModel({
    providerId: 'opencode',
    modelId: 'opencode/deepseek-v4-flash',
    family: 'opencode',
    name: 'DeepSeek V4 Flash',
  }), true);

  // models.dev discovery: bare model id, no family metadata.
  assert.equal(isDeepSeekModel({
    providerId: 'opencode',
    modelId: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
  }), true);

  // Direct DeepSeek provider.
  assert.equal(isDeepSeekModel({
    providerId: 'deepseek',
    modelId: 'deepseek/deepseek-v4-pro',
    family: 'deepseek',
    name: 'DeepSeek V4 Pro',
  }), true);

  // Bare fallback placeholder: family carries the provider id.
  assert.equal(isDeepSeekModel({
    providerId: 'deepseek',
    modelId: 'deepseek/default',
    family: 'deepseek',
  }), true);
});

test('does not treat non-DeepSeek reasoning models as DeepSeek', () => {
  for (const candidate of [
    { providerId: 'opencode', modelId: 'opencode/kimi-k2-thinking', family: 'opencode', name: 'Kimi K2 Thinking' },
    { providerId: 'opencode', modelId: 'opencode/gemini-3-pro', family: 'opencode', name: 'Gemini 3 Pro' },
    { providerId: 'opencode', modelId: 'opencode/claude-opus-4-8', family: 'opencode', name: 'Claude Opus 4.8' },
    { providerId: 'opencode', modelId: 'opencode/gpt-5', family: 'opencode', name: 'GPT-5' },
    { providerId: 'opencode', modelId: 'opencode/grok-4.6', family: 'opencode', name: 'Grok 4.6' },
    { providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4', family: 'anthropic', name: 'Claude Sonnet 4' },
    { providerId: 'google', modelId: 'google/gemini-3.1-pro', family: 'google', name: 'Gemini 3.1 Pro' },
  ]) {
    assert.equal(isDeepSeekModel(candidate), false, JSON.stringify(candidate));
  }
});