import test from 'node:test';
import assert from 'node:assert/strict';
import { chatgptProvider } from '../src/providers/adapters.js';

function observation(overrides = {}) {
  return {
    url: 'https://chatgpt.com/c/synthetic', userMessageCount: 1,
    assistantMessageCount: 1, lastUserMessage: 'synthetic prompt',
    response: 'A completed answer.', generating: false, rateLimited: false,
    circuitBreaker: { active: true, scope: 'generation' }, ...overrides,
  };
}

test('persisted breakers allow completed and in-progress DOM observations', async () => {
  for (const scope of ['generation', 'http-429', 'unknown']) {
    for (const generating of [false, true]) {
      const state = observation({ generating, circuitBreaker: { active: true, scope } });
      const original = structuredClone(state);
      const provider = chatgptProvider({ getLatestResponse: async () => state });
      const result = await provider.inspect();
      assert.equal(result.text, state.response);
      assert.equal(result.busy, generating);
      assert.equal(result.complete, !generating);
      assert.deepEqual(state, original, 'reading must not clear or modify the breaker');
    }
  }
});

test('visible rate-limit warning allows an existing complete answer but not a partial answer or warning as answer', async () => {
  const state = observation({ rateLimited: true });
  const provider = chatgptProvider({ getLatestResponse: async () => state });
  assert.equal((await provider.inspect()).complete, true);
  for (const patch of [
    { response: 'Partial answer', generating: true },
    { response: '', generating: false },
    { response: 'Too many requests. Please wait before sending another message.', generating: false },
  ]) {
    Object.assign(state, patch);
    await assert.rejects(provider.inspect(), { code: 'RATE_LIMITED' });
  }
});
