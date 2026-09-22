import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel } from '../src/core/tasks.js';
import { Comparisons } from '../src/core/comparisons.js';

async function fixture(t) {
  const root = path.resolve(os.tmpdir()); const directory = await fs.mkdtemp(path.join(root, 'mcp-compare-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  const sends = []; const providers = ['chatgpt', 'gemini'].map((id) => {
    let page, model;
    return { id, isRoot: () => false,
      browser: { runExclusive: (fn) => fn(), newChat: async () => { page = { url: `https://example.com/${id}`, userCount: 0, responseCount: 0 }; }, selectModel: async (m) => { model = m; if (m === 'unavailable') throw new Error('Unavailable'); } },
      prepare: async () => ({ ...page }),
      send: async ({ prompt }) => { sends.push({ id, model, prompt }); Object.assign(page, { userCount: 1, lastUser: prompt, responseCount: 1, text: `${id}:${model}`, complete: true, busy: false }); return { url: page.url }; },
      inspect: async () => ({ ...page }), settle: async () => {},
    };
  });
  const kernel = new TaskKernel(providers, { directory });
  return { kernel, sends, directory, comparisons: new Comparisons(kernel) };
}
test('same question reaches explicit targets, same-provider models use separate tasks, replay survives restart', async (t) => {
  const f = await fixture(t);
  const input = { request_id: 'comparison-one', prompt: 'PRIVATE_QUESTION', targets: [{ provider: 'gemini', model: 'A' }, { provider: 'gemini', model: 'B' }, { provider: 'chatgpt', model: 'C' }] };
  const result = await f.comparisons.run(input);
  assert.equal(result.all_succeeded, true); assert.equal(f.sends.length, 3);
  assert.deepEqual(f.sends.filter((s) => s.id === 'gemini').map((s) => s.model), ['A', 'B']);
  assert.equal(new Set(result.targets.map((target) => target.task.task_id)).size, 3);
  const next = new Comparisons(new TaskKernel([...f.kernel.providers.values()], { directory: f.directory }));
  assert.equal((await next.run(input)).all_succeeded, true); assert.equal(f.sends.length, 3);
  assert.equal((await next.result(result.comparison_id)).all_succeeded, true);
  const record = await fs.readFile(f.comparisons.file(result.comparison_id), 'utf8');
  assert.ok(!record.includes(input.prompt));
  await assert.rejects(next.run({ ...input, prompt: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('failed model remains isolated and result never starts another target', async (t) => {
  const f = await fixture(t);
  const input = { request_id: 'two', prompt: 'question', targets: [{ provider: 'gemini', model: 'unavailable' }, { provider: 'chatgpt', model: 'C' }] };
  const result = await f.comparisons.run(input);
  assert.equal(result.complete, true); assert.equal(result.all_succeeded, false);
  assert.equal(result.targets[0].task.state, 'failed'); assert.equal(result.targets[1].task.state, 'completed');
  await f.comparisons.result(result.comparison_id); assert.equal(f.sends.length, 1);
});
test('uncertain child pauses its provider; other providers complete; result does not send', async (t) => {
  const f = await fixture(t);
  f.kernel.provider('gemini').send = async () => { throw new Error('click outcome unknown'); };
  const result = await f.comparisons.run({ request_id: 'three', prompt: 'q', targets: [{ provider: 'gemini', model: 'A' }, { provider: 'gemini', model: 'B' }, { provider: 'chatgpt', model: 'C' }] });
  assert.equal(result.targets[0].task.state, 'uncertain'); assert.equal(result.targets[1].task, null); assert.equal(result.targets[2].task.state, 'completed');
  assert.equal(result.needs_run, true);
  await f.comparisons.result(result.comparison_id); assert.equal(f.sends.length, 1);
});
test('duplicate targets and unspecified model are rejected before any sends', async (t) => {
  const f = await fixture(t); const target = { provider: 'gemini', model: 'A' };
  await assert.rejects(f.comparisons.run({ request_id: 'bad', prompt: 'q', targets: [target, target] }), { code: 'DUPLICATE_TARGET' });
  await assert.rejects(f.comparisons.run({ request_id: 'bad', prompt: 'q', targets: [target, { provider: 'chatgpt' }] }), { code: 'INVALID_MODEL' });
  assert.equal(f.sends.length, 0);
});
