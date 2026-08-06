import assert from 'node:assert/strict';
import test from 'node:test';

import { extractZenReasoning } from './zenReasoning.js';

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
