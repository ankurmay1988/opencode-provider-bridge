import assert from 'node:assert/strict';
import { classifyProviderError } from './providerErrors.js';
import test from 'node:test';

test('classifies the live Go subscription denial as access rather than an invalid key', () => {
  assert.equal(classifyProviderError(403,
    'Upstream request failed: An active OpenCode Go subscription is required to use Go models.'), 'access');
});

test('classifies the live Zen free-tier restriction as access rather than an invalid key', () => {
  assert.equal(classifyProviderError(403,
    "OpenCode's free tier can only be used from within OpenCode"), 'access');
});

test('recognizes explicit invalid and missing API keys independently of HTTP status', () => {
  for (const status of [0, 401, 403]) {
    assert.equal(classifyProviderError(status, 'Invalid API key.'), 'invalid-key');
    assert.equal(classifyProviderError(status, 'Missing API key.'), 'invalid-key');
  }
});

test('does not infer an invalid key from an HTTP 401 alone', () => {
  assert.equal(classifyProviderError(401, 'Model is not supported.'), 'authentication');
  assert.equal(classifyProviderError(401, 'Request blocked by upstream provider.'), 'authentication');
});

test('classifies quota errors before generic authentication and access failures', () => {
  assert.equal(classifyProviderError(401, 'Insufficient_quota'), 'quota');
  assert.equal(classifyProviderError(403, 'Monthly quota exceeded'), 'quota');
  assert.equal(classifyProviderError(402, 'Payment required'), 'quota');
});

test('preserves rate-limit and ordinary request classification', () => {
  assert.equal(classifyProviderError(429, 'Limit reached'), 'rate-limit');
  assert.equal(classifyProviderError(503, 'Rate limit exceeded'), 'rate-limit');
  assert.equal(classifyProviderError(500, 'Internal server error'), 'request');
  assert.equal(classifyProviderError(400, 'Invalid tool input'), 'request');
});