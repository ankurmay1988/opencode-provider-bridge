import assert from 'node:assert/strict';
import test from 'node:test';
import type { Provider } from '@opencode-ai/sdk';
import {
  configProvidersFromConfigFile,
  parseJsonc,
  sdkProviderToEntry,
} from './opencodeConfig.js';

test('sdkProviderToEntry extracts apiKey from options.apiKey when sp.key is undefined', () => {
  const provider: Provider = {
    id: 'openai',
    name: 'OpenAI',
    source: 'config',
    env: [],
    key: undefined,
    options: {
      apiKey: 'test-custom-key',
      baseURL: 'https://llms.private.example.com/v1',
      npm: '@ai-sdk/openai',
    },
    models: {
      'gpt-5.5': {
        id: 'openai/gpt-5.5',
        name: 'Gpt 5.5',
        providerID: 'openai',
        api: {
          id: 'openai/gpt-5.5',
          url: '',
          npm: '@ai-sdk/openai',
        },
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
        },
        cost: { input: 5, output: 30, cache: { read: 0.5, write: 0 } },
        limit: { context: 1050000, output: 128000 },
        status: 'active',
        options: {},
        headers: {},
      },
    },
  };

  const entry = sdkProviderToEntry(provider);
  assert.ok(entry);
  assert.equal(entry.credential.key, 'test-custom-key');
  assert.equal(entry.provider.api, 'https://llms.private.example.com/v1');
  assert.equal(entry.provider.npm, '@ai-sdk/openai');
  assert.equal(entry.models.length, 1);
  assert.equal(entry.models[0][0], 'gpt-5.5');
  assert.equal(entry.models[0][1].apiNpm, '@ai-sdk/openai');
});

test('sdkProviderToEntry preserves sp.key when provided', () => {
  const provider: Provider = {
    id: 'opencode',
    name: 'OpenCode Zen',
    source: 'api',
    env: [],
    key: 'zen-direct-key',
    options: {},
    models: {
      'zen-model': {
        id: 'zen-model',
        name: 'Zen Model',
        providerID: 'opencode',
        api: { id: 'zen-model', url: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible' },
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
        },
        cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
        limit: { context: 32000, output: 4096 },
        status: 'active',
        options: {},
        headers: {},
      },
    },
  };

  const entry = sdkProviderToEntry(provider);
  assert.ok(entry);
  assert.equal(entry.credential.key, 'zen-direct-key');
});

test('parseJsonc parses JSON with comments and trailing commas', () => {
  const jsonc = `
    {
      // A comment
      "provider": {
        /* block comment */
        "test": {
          "key": "val",
        },
      },
    }
  `;
  const parsed = parseJsonc(jsonc);
  assert.deepEqual(parsed, { provider: { test: { key: 'val' } } });
});

test('configProvidersFromConfigFile builds provider entries from opencode.json structure', () => {
  const config = {
    provider: {
      anthropic: {
        name: 'Custom Anthropic',
        options: {
          apiKey: 'anthropic-secret',
          baseURL: 'https://llms.example.com/v1',
        },
        npm: '@ai-sdk/openai',
        models: {
          'claude-sonnet-4-5': {
            id: 'anthropic/claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            tool_call: true,
            reasoning: true,
            limit: { context: 200000, output: 64000 },
          },
        },
      },
    },
  };

  const result = configProvidersFromConfigFile(config);
  assert.equal(result.size, 1);
  const entry = result.get('anthropic');
  assert.ok(entry);
  assert.equal(entry.provider.name, 'Custom Anthropic');
  assert.equal(entry.credential.key, 'anthropic-secret');
  assert.equal(entry.provider.api, 'https://llms.example.com/v1');
  assert.equal(entry.provider.npm, '@ai-sdk/openai');
  assert.equal(entry.models.length, 1);
  assert.equal(entry.models[0][0], 'claude-sonnet-4-5');
  assert.equal(entry.models[0][1].apiNpm, '@ai-sdk/openai');
});
