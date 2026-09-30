import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel, validateJournal } from '../src/core/tasks.js';
import { chatgptProvider } from '../src/providers/adapters.js';
import { readState, writeState } from '../src/shared/persistent-browser.js';
import { sessionView, mergeSessionView, validateSessionId } from '../src/shared/sessions.js';

async function fixture(t, id = 'chatgpt') {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'web-chat-sessions-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  const pages = new Map(), sends = [], cancelled = [], settings = [];
  function adapter(session = 'legacy') {
    if (!pages.has(session)) pages.set(session, { url: `https://example.com/${session}`, userCount: 0, responseCount: 0, busy: false });
    const page = pages.get(session);
    return { id, isRoot: () => false,
      browser: { runExclusive: fn => fn(), selectAnswerTier: async tier => { settings.push({ session, tier }); return { selected: tier }; }, enableWebSearch: async () => settings.push({ session, search: true }) },
      prepare: async () => ({ ...page }),
      send: async ({ prompt }) => { sends.push(session); Object.assign(page, { userCount: page.userCount + 1, lastUser: prompt, busy: true, complete: false }); return { url: page.url }; },
      inspect: async () => ({ ...page }), settle: async () => {},
      cancel: async () => { cancelled.push(session); page.busy = false; },
    };
  }
  const provider = { ...adapter(), forSession: adapter };
  const kernel = new TaskKernel([provider], { directory });
  const input = session => ({ provider: id, session_id: session, request_id: session || 'legacy', prompt: `question ${session}` });
  return { kernel, provider, pages, sends, cancelled, settings, directory, input, journal: path.join(directory, id, 'tasks.json') };
}

for (const id of ['chatgpt', 'gemini']) {
  test(`${id}: independent sessions remain active together; restart and cancel cannot cross tabs`, async t => {
    const f = await fixture(t, id);
    const [a, b] = await Promise.all([f.kernel.send(f.input('a')), f.kernel.send(f.input('b'))]);
    assert.equal(a.state, 'submitted'); assert.equal(b.state, 'submitted');
    assert.equal((await f.kernel.list(id)).active_tasks.length, 2);
    await assert.rejects(f.kernel.send({ ...f.input('a'), request_id: 'a-second' }), { code: 'TASK_ACTIVE' });
    await assert.rejects(f.kernel.run(id, () => assert.fail(), { sessionId: 'a' }), { code: 'TASK_ACTIVE' });
    const restarted = new TaskKernel([f.provider], { directory: f.directory });
    assert.equal((await restarted.send(f.input('b'))).replayed, true);
    assert.equal((await restarted.read(a.task_id, { cancel: true })).state, 'cancelled');
    assert.deepEqual(f.cancelled, ['a']); assert.equal(f.pages.get('b').busy, true);
    Object.assign(f.pages.get('b'), { responseCount: 1, text: 'answer B', busy: false, complete: true });
    assert.equal((await restarted.result(b.task_id)).response.text, 'answer B');
    assert.equal(f.sends.length, 2); assert.equal((await restarted.list(id)).active_tasks.length, 0);
  });
}

test('uncertain legacy task does not block named session or get released by its completion', async t => {
  const f = await fixture(t);
  const legacy = await f.kernel.send(f.input());
  f.pages.get('legacy').url += '/changed';
  assert.equal((await f.kernel.read(legacy.task_id)).state, 'uncertain');
  const b = await f.kernel.send(f.input('research'));
  Object.assign(f.pages.get('research'), { responseCount: 1, text: 'done', busy: false, complete: true });
  assert.equal((await f.kernel.read(b.task_id)).state, 'completed');
  assert.equal((await f.kernel.list('chatgpt')).active_task, legacy.task_id);
  await assert.rejects(f.kernel.run('chatgpt', () => assert.fail()), { code: 'TASK_ACTIVE' });
  assert.equal((await readState(f.journal)).version, 2);
});

test('session, Pro tier and web search are part of idempotency; settings are verified before send', async t => {
  const f = await fixture(t);
  const input = { ...f.input('research'), answer_tier: 'Pro', web_search: true };
  const task = await f.kernel.send(input);
  assert.equal(task.answer_tier.selected, 'Pro');
  assert.deepEqual(f.settings, [{ session: 'research', tier: 'Pro' }, { session: 'research', search: true }]);
  for (const patch of [{ session_id: 'other' }, { answer_tier: 'High' }, { web_search: false }]) await assert.rejects(f.kernel.send({ ...input, ...patch }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.sends.length, 1);
});

test('invalid sessions, unsupported settings and failed tier checks never send', async t => {
  const f = await fixture(t);
  for (const id of ['', '../escape', '__proto__', 'constructor', null, 42]) assert.throws(() => validateSessionId(id), { code: 'INVALID_SESSION' });
  const adapter = f.kernel.adapter('chatgpt', 'pro');
  adapter.browser.selectAnswerTier = async () => { throw new Error('Pro unavailable'); };
  assert.equal((await f.kernel.send({ ...f.input('pro'), answer_tier: 'Pro' })).state, 'failed');
  assert.equal(f.sends.length, 0);
  const g = await fixture(t, 'gemini');
  await assert.rejects(g.kernel.send({ ...g.input('test'), answer_tier: 'Pro' }), { code: 'UNSUPPORTED_SETTING' });
  assert.equal(g.sends.length, 0);
});

test('changed tab identity cannot be cancelled or read as the other session', async t => {
  const f = await fixture(t);
  const a = await f.kernel.send(f.input('a')), b = await f.kernel.send(f.input('b'));
  Object.assign(f.pages.get('a'), f.pages.get('b'));
  assert.equal((await f.kernel.read(a.task_id, { cancel: true })).error.code, 'CONVERSATION_CHANGED');
  assert.deepEqual(f.cancelled, []);
  assert.equal((await f.kernel.read(b.task_id)).state, 'running');
});

test('synchronized tab navigation restores each saved conversation before reading or cancelling', async t => {
  const f = await fixture(t);
  const a = await f.kernel.send(f.input('a')), b = await f.kernel.send(f.input('b'));
  const snapshots = new Map([...f.pages.values()].map(page => [page.url, { ...page }]));
  const restored = [];
  for (const session of ['a', 'b']) f.kernel.adapter('chatgpt', session).restore = async url => {
    restored.push(url);
    for (const page of f.pages.values()) Object.assign(page, snapshots.get(url));
  };
  Object.assign(f.pages.get('a'), f.pages.get('b'));
  assert.equal((await f.kernel.read(a.task_id)).state, 'running');
  assert.equal((await f.kernel.read(b.task_id, { cancel: true })).state, 'cancelled');
  assert.deepEqual(restored, [a.conversation_url, b.conversation_url]);
  assert.deepEqual(f.cancelled, ['b']); assert.equal(f.sends.length, 2);
});

test('explicit navigation takes precedence over automatic follow-up restoration', async t => {
  const f = await fixture(t); const a = await f.kernel.send(f.input('a'));
  Object.assign(f.pages.get('a'), { responseCount: 1, text: 'done', busy: false, complete: true });
  await f.kernel.result(a.task_id);
  const adapter = f.kernel.adapter('chatgpt', 'a');
  adapter.restore = async () => assert.fail('explicit new conversation must be preserved');
  await f.kernel.run('chatgpt', async () => { f.pages.get('a').url = 'https://example.com/new'; }, { sessionId: 'a', conversationChanged: true });
  const b = await f.kernel.send({ ...f.input('a'), request_id: 'a-new' });
  assert.equal(b.state, 'submitted'); assert.equal(b.conversation_url, 'https://example.com/new');
});

test('different session names cannot submit into the same active conversation', async t => {
  const f = await fixture(t);
  await f.kernel.send(f.input('a'));
  f.kernel.adapter('chatgpt', 'b');
  f.pages.get('b').url = f.pages.get('a').url;
  const result = await f.kernel.send(f.input('b'));
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'CONVERSATION_ACTIVE');
  assert.deepEqual(f.sends, ['a']);
});

test('v2 journal fails closed on duplicate active sessions and preserves legacy schema validation', async t => {
  const f = await fixture(t); await f.kernel.send(f.input('a')); await f.kernel.send(f.input('b'));
  const state = await readState(f.journal);
  Object.values(state.tasks)[1].session_id = 'a';
  assert.throws(() => validateJournal(state, 'chatgpt'), { code: 'INVALID_JOURNAL' });
  state.version = 1;
  assert.throws(() => validateJournal(state, 'chatgpt'), { code: 'INVALID_JOURNAL' });
});

test('per-session runtime updates preserve other answers and account-level rate limiting', () => {
  const fields = ['activeGeneration'];
  const raw = { activeGeneration: { id: 'legacy' }, lastSendAt: 5, circuitBreaker: { active: true }, sessions: { a: { activeGeneration: { id: 'A' } }, b: { activeGeneration: { id: 'B' } } } };
  const a = sessionView(raw, 'a', fields);
  assert.equal(a.activeGeneration.id, 'A'); assert.equal(a.circuitBreaker.active, true);
  const merged = mergeSessionView(raw, { ...a, activeGeneration: null, lastSendAt: 10 }, 'a', fields);
  assert.equal(merged.activeGeneration.id, 'legacy'); assert.equal(merged.sessions.b.activeGeneration.id, 'B');
  assert.equal(merged.sessions.a.activeGeneration, null); assert.equal(merged.lastSendAt, 10);
  assert.equal(sessionView(raw, 'new', fields).activeGeneration, null);
});

test('local-chatgpt provisional URL is reconciled by prompt identity, including an old journal', async t => {
  const f = await fixture(t); const page = f.pages.get('legacy'); page.url = 'https://chatgpt.com/';
  f.provider.isRoot = url => url === 'https://chatgpt.com'; f.provider.isProvisional = chatgptProvider({}).isProvisional;
  const task = await f.kernel.send(f.input());
  const state = await readState(f.journal);
  state.tasks[task.task_id].conversation_url = 'https://chatgpt.com/c/local-chatgpt%3Atemporary';
  await writeState(f.journal, state);
  Object.assign(page, { url: 'https://chatgpt.com/c/permanent', responseCount: 1, complete: true, busy: false, text: 'recovered' });
  assert.equal((await f.kernel.result(task.task_id)).response.text, 'recovered');
  assert.equal(f.sends.length, 1);
});
