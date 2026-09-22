import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLock, readState, writeState, WebUIError } from '../shared/persistent-browser.js';
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const done = (t) => ['completed', 'cancelled', 'failed', 'abandoned'].includes(t?.state);

// No prompt text is journaled. Resume unsent targets by repeating run() with the
// original input. result() only observes existing children and never sends.
export class Comparisons {
  constructor(kernel) { this.kernel = kernel; }
  file(id) {
    if (!/^compare:[a-f0-9]{64}$/.test(id)) throw new WebUIError('INVALID_COMPARISON', 'Invalid comparison_id.');
    return path.join(this.kernel.directory, 'comparisons', `${id.slice(8)}.json`);
  }
  async run({ request_id, prompt, targets, timeoutMs = 30000 }, { signal } = {}) {
    if (typeof request_id !== 'string' || !request_id.trim() || request_id.length > 128 || typeof prompt !== 'string' || !prompt.trim()) throw new WebUIError('INVALID_COMPARISON', 'Provide a stable request_id and nonempty prompt.');
    if (!Array.isArray(targets) || targets.length < 2 || targets.length > 6) throw new WebUIError('INVALID_TARGETS', 'Choose 2..6 explicit provider/model targets.');
    targets = targets.map(({ provider, model }) => {
      this.kernel.provider(provider);
      if (typeof model !== 'string' || !model.trim()) throw new WebUIError('INVALID_MODEL', 'Every target needs an exact model name from chat_models.');
      return { provider, model };
    });
    if (new Set(targets.map((t) => hash(t))).size !== targets.length) throw new WebUIError('DUPLICATE_TARGET', 'Each provider/model pair must be distinct.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new WebUIError('INVALID_TIMEOUT', 'timeoutMs must be 1000..300000.');
    const id = `compare:${hash(request_id)}`;
    const file = this.file(id);
    const release = await acquireLock(`${file}.lock`, { signal });
    try {
      let state = await readState(file);
      const fingerprint = hash({ prompt, targets });
      if (state.fingerprint && state.fingerprint !== fingerprint) throw new WebUIError('IDEMPOTENCY_CONFLICT', 'Comparison request_id was already used with different input.');
      if (!state.fingerprint) {
        if (Object.keys(state).length) throw new WebUIError('INVALID_COMPARISON', 'Damaged comparison record.');
        state = { version: 1, comparison_id: id, fingerprint, created_at: Date.now(), targets };
        await writeState(file, state);
      }
      this.validate(state, id);
      const deadline = Date.now() + timeoutMs;
      const errors = {};
      // Same-provider models run in order in fresh conversations; providers run
      // independently. Every child uses the durable kernel's replay protection.
      await Promise.all([...new Set(targets.map((t) => t.provider))].map(async (provider) => {
        for (let index = 0; index < targets.length; index++) {
          const target = targets[index];
          if (target.provider !== provider || signal?.aborted || Date.now() >= deadline) continue;
          try {
            let task = await this.kernel.send({ ...target, prompt, request_id: `${id}:${index}`, newConversation: true }, { signal });
            if (!done(task)) task = await this.kernel.result(task.task_id, { wait: true, timeoutMs: Math.max(1000, deadline - Date.now()), signal });
            if (!done(task)) break;
          } catch (error) { errors[index] = { code: error.code || 'COMPARISON_ERROR', message: error.message }; break; }
        }
      }));
      return this.view(state, { errors });
    } finally { await release(); }
  }
  validate(state, id) {
    if (state.version !== 1 || state.comparison_id !== id || !Array.isArray(state.targets) || state.targets.length < 2 || state.targets.length > 6) throw new WebUIError('INVALID_COMPARISON', 'Missing or damaged comparison record.');
    for (const target of state.targets) { this.kernel.provider(target.provider); if (typeof target.model !== 'string' || !target.model.trim()) throw new WebUIError('INVALID_COMPARISON', 'Damaged comparison target.'); }
  }
  async view(state, { observe = false, signal, errors = {} } = {}) {
    const targets = await Promise.all(state.targets.map(async (target, index) => {
      let task = await this.kernel.findRequest(target.provider, `${state.comparison_id}:${index}`);
      if (observe && task && !done(task)) task = await this.kernel.result(task.task_id, { signal });
      return { ...target, task, ...(errors[index] ? { error: errors[index] } : {}) };
    }));
    return { comparison_id: state.comparison_id, created_at: state.created_at, complete: targets.every((t) => done(t.task)), all_succeeded: targets.every((t) => t.task?.state === 'completed'), needs_run: targets.some((t) => !t.task), targets, next_action: 'Use chat_compare_result to observe existing tasks. Repeat chat_compare with identical input to continue unsent targets; never change request_id to retry.' };
  }
  async result(id, { signal } = {}) {
    const state = await readState(this.file(id)); this.validate(state, id);
    return this.view(state, { observe: true, signal });
  }
}
