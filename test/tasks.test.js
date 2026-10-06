import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel } from '../src/core/tasks.js';
import { readState, writeState } from '../src/shared/persistent-browser.js';
import { chatgptProvider } from '../src/providers/adapters.js';

async function fixture(t, id = 'gemini') {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'web-chat-tasks-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  let sends = 0, cancels = 0;
  const page = { url: 'https://example.com/chat/1', userCount: 0, responseCount: 0, lastUser: '', busy: false, complete: false, text: '' };
  const adapter = {
    id, browser: { runExclusive: async (fn) => fn() }, isRoot: () => false,
    prepare: async () => ({ ...page }),
    send: async ({ prompt }) => { sends++; page.userCount++; page.lastUser = prompt; page.busy = true; return { url: page.url }; },
    inspect: async () => ({ ...page }), settle: async () => {},
    cancel: async () => { cancels++; page.busy = false; },
  };
  const kernel = new TaskKernel([adapter], { directory });
  const input = { provider: id, request_id: 'one', prompt: 'synthetic private prompt' };
  return { kernel, adapter, page, input, directory, journal: path.join(directory, id, 'tasks.json'), sends: () => sends, cancels: () => cancels };
}

for (const id of ['chatgpt', 'gemini']) {
  test(`${id}: replay survives restart, rejects content conflicts and stores no prompt text`, async (t) => {
    const f = await fixture(t, id);
    const first = await f.kernel.send(f.input);
    const restarted = new TaskKernel([f.adapter], { directory: f.directory });
    const replay = await restarted.send(f.input);
    assert.equal(replay.task_id, first.task_id); assert.equal(replay.replayed, true); assert.equal(f.sends(), 1);
    await assert.rejects(restarted.send({ ...f.input, prompt: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.ok(!(await fs.readFile(f.journal, 'utf8')).includes(f.input.prompt));
    Object.assign(f.page, { responseCount: 1, busy: false, complete: true, text: 'final' });
    assert.equal((await restarted.result(first.task_id)).response.text, 'final');
    f.adapter.inspect = async () => assert.fail('cached completion must not access browser');
    assert.equal((await restarted.result(first.task_id)).state, 'completed');
    assert.equal((await restarted.list(id)).active_task, null);
  });
  test(`${id}: active task gates legacy mutations and cancellation verifies identity`, async (t) => {
    const f = await fixture(t, id); const task = await f.kernel.send(f.input);
    await assert.rejects(f.kernel.run(id, () => assert.fail()), { code: 'TASK_ACTIVE' });
    assert.equal(await f.kernel.run(id, () => 'status', { readOnly: true }), 'status');
    f.page.url += '/other';
    assert.equal((await f.kernel.read(task.task_id, { cancel: true })).error.code, 'CONVERSATION_CHANGED');
    assert.equal(f.cancels(), 0);
    f.page.url = 'https://example.com/chat/1';
    f.page.lastUser = 'different';
    assert.equal((await f.kernel.read(task.task_id, { cancel: true })).error.code, 'SEND_UNCONFIRMED');
    f.page.lastUser = f.input.prompt;
    assert.equal((await f.kernel.read(task.task_id, { cancel: true })).state, 'cancelled');
    assert.equal(f.cancels(), 1); assert.equal(f.sends(), 1);
  });
}

test('uncertain delivery reconciles without another send', async (t) => {
  const f = await fixture(t); const send = f.adapter.send;
  f.adapter.send = async (i) => { await send(i); throw new Error('connection lost after click'); };
  const task = await f.kernel.send(f.input); assert.equal(task.state, 'uncertain');
  Object.assign(f.page, { responseCount: 1, busy: false, complete: true, text: 'recovered' });
  assert.equal((await f.kernel.result(task.task_id)).state, 'completed'); assert.equal(f.sends(), 1);
});

test('retry replaces the completed response once, including concurrent calls and restart replay', async t => {
  const f = await fixture(t); const original = await f.kernel.send(f.input);
  Object.assign(f.page, { responseCount: 1, busy: false, complete: true, text: 'refusal' });
  await f.kernel.result(original.task_id);
  let clicks = 0;
  f.adapter.prepareRetry = async () => async () => { clicks++; f.page.busy = true; f.page.complete = false; return { started: true }; };
  const next = new TaskKernel([f.adapter], { directory: f.directory });
  const results = await Promise.all([f.kernel.retry(original.task_id), next.retry(original.task_id)]);
  assert.equal(clicks, 1); assert.equal(results.filter(r => r.replayed).length, 1);
  assert.equal((await next.result(original.task_id)).state, 'running');
  Object.assign(f.page, { busy: false, complete: true, text: 'helpful answer' });
  const completed = await next.result(original.task_id);
  assert.equal(completed.response.text, 'helpful answer'); assert.equal(completed.previous_response.text, 'refusal');
  assert.equal(completed.retry_count, 1); assert.equal(f.sends(), 1); assert.equal(f.page.userCount, 1);
  assert.equal((await next.retry(original.task_id)).replayed, true); assert.equal(clicks, 1);
});

test('unconfirmed retry never returns the cached refusal or clicks again, but observation can recover', async t => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  Object.assign(f.page, { responseCount: 1, busy: false, complete: true, text: 'refusal' });
  await f.kernel.result(task.task_id);
  let clicks = 0;
  f.adapter.prepareRetry = async () => async () => { clicks++; throw new Error('connection lost'); };
  assert.equal((await f.kernel.retry(task.task_id)).state, 'uncertain');
  assert.equal((await f.kernel.result(task.task_id)).error.code, 'RETRY_UNCONFIRMED');
  await f.kernel.retry(task.task_id); assert.equal(clicks, 1);
  Object.assign(f.page, { busy: true, complete: false });
  assert.equal((await f.kernel.result(task.task_id)).state, 'running');
  Object.assign(f.page, { busy: false, complete: true });
  assert.equal((await f.kernel.result(task.task_id)).response.text, 'refusal', 'A second identical refusal is final after observed generation');
});

test('retry refuses active, changed and superseded targets before any click', async t => {
  const f = await fixture(t); let prepares = 0;
  f.adapter.prepareRetry = async () => { prepares++; return async () => ({ started: true }); };
  const task = await f.kernel.send(f.input);
  await assert.rejects(f.kernel.retry(task.task_id), { code: 'RETRY_NOT_COMPLETED' });
  Object.assign(f.page, { responseCount: 1, busy: false, complete: true, text: 'refusal', model: 'Flash Extended' });
  await f.kernel.result(task.task_id);
  f.page.lastUser = 'different';
  await assert.rejects(f.kernel.retry(task.task_id), { code: 'RETRY_TARGET_CHANGED' });
  f.page.lastUser = f.input.prompt; f.page.model = 'Flash';
  await assert.rejects(f.kernel.retry(task.task_id), { code: 'RETRY_MODEL_CHANGED' });
  f.page.model = 'Flash Extended'; f.page.url += '/different';
  await assert.rejects(f.kernel.retry(task.task_id), { code: 'CONVERSATION_CHANGED' });
  f.page.url = 'https://example.com/chat/1';
  await f.kernel.send({ ...f.input, request_id: 'later' });
  await assert.rejects(f.kernel.retry(task.task_id), { code: 'TASK_SUPERSEDED' });
  assert.equal(prepares, 0);
});
test('delayed UI acknowledgement stays submitted without resending and later completes', async (t) => {
  const f = await fixture(t); const send = f.adapter.send;
  f.adapter.send = async () => ({ url: f.page.url });
  const task = await f.kernel.send(f.input);
  assert.equal((await f.kernel.result(task.task_id)).state, 'submitted');
  await send(f.input); Object.assign(f.page, { responseCount: 1, complete: true, busy: false, text: 'acknowledged' });
  assert.equal((await f.kernel.result(task.task_id)).state, 'completed');
  assert.equal(f.sends(), 1);
});
test('ChatGPT provisional WEB conversation URL is not pinned as permanent identity', async (t) => {
  const f = await fixture(t, 'chatgpt');
  f.page.url = 'https://chatgpt.com/';
  f.adapter.isRoot = (url) => url === 'https://chatgpt.com';
  f.adapter.isProvisional = chatgptProvider({}).isProvisional;
  const send = f.adapter.send;
  f.adapter.send = async (i) => { const result = await send(i); f.page.url = 'https://chatgpt.com/c/WEB:temporary'; return { ...result, url: f.page.url }; };
  const task = await f.kernel.send(f.input);
  assert.equal(task.conversation_url, undefined);
  Object.assign(f.page, { url: 'https://chatgpt.com/c/permanent', busy: false, complete: true, responseCount: 1, text: 'final' });
  const result = await f.kernel.result(task.task_id);
  assert.equal(result.state, 'completed'); assert.equal(result.conversation_url, f.page.url);
});
test('preflight failures release reservation, missing attachments never touch page', async (t) => {
  const f = await fixture(t);
  f.adapter.prepare = async () => assert.fail('missing file must fail before browser preflight');
  assert.equal((await f.kernel.send({ ...f.input, files: [path.join(f.directory, 'missing')] })).state, 'failed');
  assert.equal((await f.kernel.list('gemini')).active_task, null); assert.equal(f.sends(), 0);
});
test('crash before send is released; damaged journals fail closed', async (t) => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  const state = await readState(f.journal); state.tasks[task.task_id].state = 'preparing'; await writeState(f.journal, state);
  assert.equal((await f.kernel.result(task.task_id)).error.code, 'PREFLIGHT_INTERRUPTED');
  state.active = 'missing'; await writeState(f.journal, state);
  await assert.rejects(f.kernel.send({ ...f.input, request_id: 'two' }), { code: 'INVALID_JOURNAL' });
});
test('concurrent replay through independent kernels sends only once', async (t) => {
  const f = await fixture(t); const other = new TaskKernel([f.adapter], { directory: f.directory });
  const tasks = await Promise.all([f.kernel.send(f.input), other.send(f.input)]);
  assert.equal(tasks[0].task_id, tasks[1].task_id); assert.equal(f.sends(), 1);
});
test('different providers operate independently', async (t) => {
  const f = await fixture(t); const other = { ...f.adapter, id: 'chatgpt' };
  const kernel = new TaskKernel([f.adapter, other], { directory: f.directory });
  await kernel.send(f.input);
  assert.equal(await kernel.run('chatgpt', () => 'available'), 'available');
});
test('timeout and abort retain task and never resend', async (t) => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  assert.equal((await f.kernel.result(task.task_id, { wait: true, timeoutMs: 1000 })).timed_out, true);
  await assert.rejects(f.kernel.result(task.task_id, { wait: true, signal: AbortSignal.abort() }));
  assert.equal((await f.kernel.list('gemini')).active_task, task.task_id); assert.equal(f.sends(), 1);
});
test('abandon requires confirmation and idle original page; request id remains reserved', async (t) => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  await assert.rejects(f.kernel.abandon(task.task_id), { code: 'CONFIRM_REQUIRED' });
  await assert.rejects(f.kernel.abandon(task.task_id, { confirm: true }), { code: 'GENERATING' });
  f.page.busy = false;
  assert.equal((await f.kernel.abandon(task.task_id, { confirm: true })).state, 'abandoned');
  assert.equal((await f.kernel.send(f.input)).replayed, true); assert.equal(f.sends(), 1);
});

test('explicit result refresh corrects a premature completion and preserves the old observation', async t => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  Object.assign(f.page, { responseCount: 1, busy: false, complete: true, text: 'reasoning summary' });
  assert.equal((await f.kernel.result(task.task_id)).state, 'completed');
  Object.assign(f.page, { busy: true, complete: false });
  const refreshed = await f.kernel.result(task.task_id, { refresh: true });
  assert.equal(refreshed.state, 'running'); assert.equal(refreshed.response, null);
  assert.equal(refreshed.previous_response.text, 'reasoning summary');
  assert.equal((await f.kernel.list('gemini')).tasks[0].previous_response, undefined, 'metadata listings must not expose archived response text');
  assert.equal((await f.kernel.list('gemini')).active_task, task.task_id);
  await assert.rejects(f.kernel.send({ ...f.input, request_id: 'second' }), { code: 'TASK_ACTIVE' });
  Object.assign(f.page, { busy: false, complete: true, text: 'full answer' });
  assert.equal((await f.kernel.result(task.task_id)).response.text, 'full answer');
  assert.equal(f.sends(), 1);
});

test('refresh cannot steal a session already used by another task', async t => {
  const f = await fixture(t); const task = await f.kernel.send(f.input);
  Object.assign(f.page, { responseCount: 1, busy: false, complete: true, text: 'done' });
  await f.kernel.result(task.task_id);
  await f.kernel.send({ ...f.input, request_id: 'later' });
  await assert.rejects(f.kernel.result(task.task_id, { refresh: true }), { code: 'TASK_SUPERSEDED' });
  assert.equal((await f.kernel.result(task.task_id)).response.text, 'done');
});

test('unbound recovery URL is checked against the prompt before binding', async t => {
  const f = await fixture(t, 'chatgpt');
  f.page.url = 'https://example.com'; f.adapter.isRoot = url => url === 'https://example.com';
  const originalSend = f.adapter.send;
  f.adapter.send = async i => { await originalSend(i); return { url: f.page.url }; };
  f.adapter.restore = async url => { f.page.url = url; };
  const task = await f.kernel.send(f.input);
  assert.equal(task.conversation_url, undefined);
  f.page.lastUser = 'different prompt';
  const wrong = await f.kernel.result(task.task_id, { conversation_url: 'https://example.com/wrong' });
  assert.equal(wrong.error.code, 'SEND_UNCONFIRMED'); assert.equal(wrong.conversation_url, undefined);
  f.page.lastUser = f.input.prompt;
  const recovered = await f.kernel.result(task.task_id, { conversation_url: 'https://example.com/original' });
  assert.equal(recovered.state, 'running'); assert.equal(recovered.conversation_url, 'https://example.com/original');
  assert.equal((await f.kernel.result(task.task_id, { conversation_url: 'https://example.com/wrong' })).error.code, 'CONVERSATION_CONFLICT');
  assert.equal(f.sends(), 1);
});
