import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TaskKernel, validateJournal } from '../src/core/tasks.js';
import { diagnose } from '../src/core/diagnostics.js';
import { recoveryFor } from '../src/core/recovery.js';
import { parseManagement, executeManagement } from '../src/management.js';
import { writeState } from '../src/shared/persistent-browser.js';

async function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'mcp-management-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  const localConfig = { executable: process.execPath, runtimeState: path.join(directory, 'runtime.json'), browserState: path.join(directory, 'browser.json') };
  const provider = { id: 'gemini', capabilities: {}, localConfig, browser: { runExclusive: () => assert.fail('must not access browser') } };
  return { directory, localConfig, kernel: new TaskKernel([provider], { directory: path.join(directory, 'tasks') }) };
}
test('doctor reads local state without browser or filesystem mutation and redacts private data', async (t) => {
  const f = await fixture(t);
  await writeState(f.localConfig.runtimeState, { pending: { prompt: 'PRIVATE_PROMPT', url: 'https://private.example/' }, circuitBreaker: { active: true, secret: 'PRIVATE_SECRET' } });
  await writeState(f.localConfig.browserState, { pid: process.pid, profile: 'PRIVATE_PATH' });
  const before = await fs.readdir(f.directory);
  const result = await diagnose(f.kernel);
  assert.equal(result.ok, true); assert.equal(result.sign_in_verified, false);
  assert.equal(result.providers[0].checks.find((c) => c.name === 'runtime_state').code, 'RATE_LIMITED');
  const json = JSON.stringify(result);
  for (const secret of ['PRIVATE_', 'private.example', f.directory, String(process.pid)]) assert.ok(!json.includes(secret));
  assert.deepEqual(await fs.readdir(f.directory), before);
});
test('doctor isolates corrupted state and journal without echoing raw errors', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.localConfig.runtimeState, 'PRIVATE broken json');
  await fs.mkdir(path.join(f.kernel.directory, 'gemini'), { recursive: true });
  await writeState(path.join(f.kernel.directory, 'gemini', 'tasks.json'), null);
  const result = await diagnose(f.kernel);
  assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(result.providers[0].checks.some((c) => c.code === 'INVALID_JOURNAL'));
});
test('doctor reports locks without deleting or reclaiming them', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.kernel.directory, 'gemini', 'tasks.json.lock');
  await writeState(lock, { pid: process.pid, token: 'PRIVATE_LOCK_TOKEN' });
  const before = await fs.readFile(lock, 'utf8');
  const result = await diagnose(f.kernel);
  assert.equal(result.providers[0].checks.find((c) => c.name === 'task_lock').code, 'IN_USE');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_LOCK_TOKEN'));
  assert.equal(await fs.readFile(lock, 'utf8'), before);
});
test('task pagination is deterministic, filterable and keeps response text private', async (t) => {
  const f = await fixture(t); const tasks = {};
  for (let n = 0; n < 5; n++) {
    const id = `gemini:00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    tasks[id] = { task_id: id, provider: 'gemini', state: n === 4 ? 'failed' : 'completed', created_at: n, response: { text: 'PRIVATE_RESPONSE' } };
  }
  await writeState(path.join(f.kernel.directory, 'gemini', 'tasks.json'), { version: 1, active: null, tasks });
  const first = await f.kernel.list('gemini', 2, { state: 'completed' });
  const second = await f.kernel.list('gemini', 2, { state: 'completed', offset: first.next_offset });
  assert.equal(first.total, 4); assert.equal(second.next_offset, null);
  assert.equal(new Set([...first.tasks, ...second.tasks].map((t) => t.task_id)).size, 4);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_RESPONSE'));
  await assert.rejects(f.kernel.list('gemini', 0), { code: 'INVALID_PAGE' });
  await assert.rejects(f.kernel.list('gemini', 20, { state: 'typo' }), { code: 'INVALID_STATE' });
});
test('CLI rejects missing IDs, unknown flags, invalid pagination and unconfirmed abandonment', () => {
  for (const [cmd, args] of [['result', []], ['tasks', ['--limt', '2']], ['tasks', ['--offset', '-1']], ['doctor', ['--provider', 'bad']], ['abandon', ['gemini:00000000-0000-0000-0000-000000000000']], ['result', ['gemini:00000000-0000-0000-0000-000000000000', '--timeout', 'NaN']]]) assert.throws(() => parseManagement(cmd, args));
  assert.equal(parseManagement('tasks', ['--state', 'uncertain', '--limit', '2']).limit, 2);
});
test('management routes cancellation and recovery to the existing kernel with signal', async () => {
  const calls = []; const signal = new AbortController().signal;
  const kernel = { providers: new Map(), read: (...a) => calls.push(['read', ...a]), abandon: (...a) => calls.push(['abandon', ...a]), result: (...a) => calls.push(['result', ...a]) };
  await executeManagement(kernel, { command: 'cancel', task_id: 'id' }, signal);
  await executeManagement(kernel, { command: 'abandon', task_id: 'id', confirm: true }, signal);
  await executeManagement(kernel, { command: 'result', task_id: 'id', wait: true, timeout: 5000 }, signal);
  assert.deepEqual(calls, [['read', 'id', { cancel: true, signal }], ['abandon', 'id', { confirm: true, signal }], ['result', 'id', { wait: true, timeoutMs: 5000, signal }]]);
});
test('recovery gives specific non-retry guidance for uncertain outcomes', () => {
  for (const [code, action] of [['RATE_LIMITED', 'wait_for_manual_recovery'], ['CONVERSATION_CHANGED', 'return_to_conversation'], ['LOGIN_REQUIRED', 'manual_login'], ['SEND_UNCONFIRMED', 'inspect_page']]) {
    const recovery = recoveryFor({ state: 'uncertain', error: { code } });
    assert.equal(recovery.action, action); assert.equal(recovery.automatic_retry, false);
  }
});
test('journal rejects primitive roots and active terminal records', () => {
  for (const raw of [null, [], 1, 'x', { version: 1, tasks: { x: { task_id: 'x', provider: 'gemini', state: 'completed' } }, active: 'x' }]) assert.throws(() => validateJournal(raw, 'gemini'), { code: 'INVALID_JOURNAL' });
});
test('CLI process lists providers and exits 2 on malformed arguments without creating profiles', async (t) => {
  const f = await fixture(t); const exec = promisify(execFile);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env, WEB_CHAT_DATA_DIR: f.kernel.directory, GEMINI_WEB_DATA_DIR: path.join(f.directory, 'gemini'), CHATGPT_WEB_PROFILE: path.join(f.directory, 'chatgpt') };
  const result = await exec(process.execPath, [cli, 'providers'], { env });
  assert.deepEqual(JSON.parse(result.stdout).providers.map((p) => p.id), ['chatgpt', 'gemini']);
  await assert.rejects(exec(process.execPath, [cli, 'tasks', '--limit', '0'], { env }), (e) => e.code === 2 && e.stderr.includes('INVALID_ARGUMENTS'));
  assert.deepEqual(await fs.readdir(f.directory), []);
});
