import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUnifiedTools } from '../src/core/tools.js';

function setup(gemini = false) {
  const handlers = new Map(), calls = [];
  const browser = {
    status: async () => ({ url: 'https://chatgpt.com/c/test' }),
    renderedConversationMessages: async () => [{ author: 'user', id: 'u1', text: 'The original question' }],
    getLatestResponse: async options => {
      if (gemini) {
        assert.deepEqual(options, { wait: false });
        return { text: 'New manually requested answer', complete: true };
      }
      assert.deepEqual(options, { includeTranscript: false });
      return { lastUserMessage: 'The original question', response: '', generating: true };
    },
  };
  const kernel = {
    providers: new Map([['chatgpt', {}], ['gemini', {}]]),
    run: async (provider, fn, options) => { calls.push({ provider, options }); return fn(browser); },
    list: async () => ({ active_tasks: [{ task_id: 'chatgpt:test', state: 'uncertain' }] }),
  };
  registerUnifiedTools({ registerTool: (name, schema, handler) => handlers.set(name, handler) }, kernel);
  return { handlers, calls };
}

test('explicit status observation reads its named session without acknowledging uncertain work', async () => {
  const { handlers, calls } = setup();
  const result = await handlers.get('chat_status')({ provider: 'chatgpt', session_id: 'study', include_messages: true }, {});
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.observed.lastUserMessage, 'The original question');
  assert.equal(body.active_tasks[0].state, 'uncertain');
  assert.equal(calls.length, 3);
  assert.equal(body.observed.rendered_messages[0].id, 'u1');
  for (const { options } of calls) {
    assert.equal(options.readOnly, true);
    assert.equal(options.sessionId, 'study');
    assert.equal(options.conversationChanged, false);
  }
});

test('normal status does not expose message text', async () => {
  const { handlers, calls } = setup();
  const result = await handlers.get('chat_status')({ provider: 'chatgpt', session_id: 'study' }, {});
  assert.equal('observed' in JSON.parse(result.content[0].text), false);
  assert.equal(JSON.parse(result.content[0].text).active_task, null, 'another session must not appear as this session blocker');
  assert.equal(calls.length, 1);
});

test('Gemini latest page observation preserves uncertain tracking and uses the named session', async () => {
  const { handlers, calls } = setup(true);
  const result = await handlers.get('chat_status')({ provider: 'gemini', session_id: 'study', include_messages: true }, {});
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.observed.text, 'New manually requested answer');
  assert.equal(body.observed.complete, true);
  assert.equal(body.active_tasks[0].state, 'uncertain');
  assert.equal(calls.length, 2);
  for (const {provider, options} of calls) {
    assert.equal(provider, 'gemini');
    assert.equal(options.readOnly, true);
    assert.equal(options.sessionId, 'study');
    assert.equal(options.conversationChanged, false);
  }
});
