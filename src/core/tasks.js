import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, readState, writeState, WebUIError } from '../shared/persistent-browser.js';
import { recoveryFor } from './recovery.js';

export const textHash = (text = '') => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['completed', 'cancelled', 'failed', 'abandoned']);
export function canonicalURL(value) { const u = new URL(value); return u.origin + u.pathname.replace(/\/$/, ''); }
export function taskView(task) {
  const { baseline, promptHash, requestHash, fingerprint, ...publicFields } = task;
  return { ...publicFields, recovery: recoveryFor(task) };
}

export function validateJournal(raw, id) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0 ? { version: 1, active: null, tasks: {} } : raw;
  if (!state || state.version !== 1 || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks) ||
      (state.active !== null && (typeof state.active !== 'string' || !state.tasks[state.active] || terminal.has(state.tasks[state.active].state))) ||
      Object.entries(state.tasks).some(([key, task]) => !task || task.task_id !== key || task.provider !== id ||
        !['preparing', 'submitting', 'submitted', 'running', 'uncertain', ...terminal].includes(task.state) ||
        (!terminal.has(task.state) && state.active !== key))) throw new WebUIError('INVALID_JOURNAL', 'Unsupported or damaged task journal; nothing was sent.');
  return state;
}

// One durable journal and lock per provider. No global lock: providers can run
// independently, while legacy and unified tools share the same provider gate.
export class TaskKernel {
  constructor(providers, { directory = process.env.WEB_CHAT_DATA_DIR || path.join(os.homedir(), '.web-chat-mcp') } = {}) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.directory = path.resolve(directory);
  }
  provider(id) {
    const provider = this.providers.get(id);
    if (!provider || !/^[a-z][a-z0-9_-]*$/.test(id)) throw new WebUIError('UNKNOWN_PROVIDER', 'Unknown chat provider. Call chat_providers.');
    return provider;
  }
  taskProvider(taskId) {
    if (!/^[a-z][a-z0-9_-]*:[0-9a-f-]{36}$/.test(taskId)) throw new WebUIError('INVALID_TASK', 'Invalid task_id.');
    const id = taskId.split(':')[0]; this.provider(id); return id;
  }
  async locked(id, fn, signal) {
    this.provider(id);
    const file = path.join(this.directory, id, 'tasks.json');
    const release = await acquireLock(`${file}.lock`, { signal, timeout: 20000 });
    try {
      const raw = await readState(file);
      const state = validateJournal(raw, id);
      const save = () => writeState(file, state);
      return await fn(state, save);
    } finally { await release(); }
  }
  async run(id, fn, { signal, readOnly = false, name = 'unified-operation' } = {}) {
    return this.locked(id, async (state) => {
      if (state.active && !readOnly) throw new WebUIError('TASK_ACTIVE', `Provider has task ${state.active}. Use chat_result or chat_cancel before changing its page.`);
      return this.provider(id).browser.runExclusive(fn, { signal, name });
    }, signal);
  }
  async send({ provider: id, request_id, prompt, files = [] }, { signal } = {}) {
    if (typeof request_id !== 'string' || !request_id.trim() || request_id.length > 128) throw new WebUIError('INVALID_REQUEST_ID', 'A nonempty request_id of at most 128 characters is required. Reuse it after a timeout.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new WebUIError('EMPTY_PROMPT', 'Prompt must not be blank.');
    if (!Array.isArray(files) || files.length > 10 || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw new WebUIError('INVALID_FILES', 'Use at most ten absolute local file paths.');
    const requestHash = fingerprint(request_id);
    const payloadHash = fingerprint({ prompt, files });
    return this.locked(id, async (state, save) => {
      const existing = Object.values(state.tasks).find((task) => task.requestHash === requestHash);
      if (existing) {
        if (existing.fingerprint !== payloadHash) throw new WebUIError('IDEMPOTENCY_CONFLICT', 'This request_id was already used with different content.');
        return { ...taskView(existing), replayed: true };
      }
      if (state.active) throw new WebUIError('TASK_ACTIVE', `Provider has task ${state.active}; do not resend.`);
      const task = { task_id: `${id}:${randomUUID()}`, provider: id, state: 'preparing', requestHash, fingerprint: payloadHash, promptHash: textHash(prompt), created_at: Date.now(), updated_at: Date.now(), blocking: true, response: null, error: null };
      state.tasks[task.task_id] = task; state.active = task.task_id;
      await save();
      const adapter = this.provider(id);
      try {
        for (const file of files) {
          if (!(await fs.stat(file)).isFile()) throw new WebUIError('INVALID_FILES', 'Attachment must be a regular file.');
          await fs.access(file, fs.constants.R_OK);
        }
        await adapter.browser.runExclusive(async () => {
          task.baseline = await adapter.prepare();
          // Persist before the first possible send. A crash from this point on
          // must be reconciled from the page, never retried automatically.
          task.state = 'submitting'; task.updated_at = Date.now(); await save();
          const sent = await adapter.send({ prompt, files });
          task.state = 'submitted'; task.updated_at = Date.now();
          if (sent.url && !adapter.isProvisional?.(sent.url) && canonicalURL(sent.url) !== canonicalURL(task.baseline.url)) task.conversation_url = canonicalURL(sent.url);
          await save();
        }, { signal, name: 'chat_send' });
      } catch (error) {
        task.state = task.state === 'preparing' ? 'failed' : 'uncertain';
        task.blocking = task.state !== 'failed';
        task.error = { code: error.code || (signal?.aborted ? 'INTERRUPTED' : 'PROVIDER_ERROR'), message: error.message.split('\n')[0] };
        task.updated_at = Date.now(); if (!task.blocking) state.active = null;
        await save();
      }
      return taskView(task);
    }, signal);
  }
  async read(taskId, { signal, cancel = false } = {}) {
    const id = this.taskProvider(taskId);
    return this.locked(id, async (state, save) => {
      const task = state.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      if (terminal.has(task.state)) return taskView(task);
      if (task.state === 'preparing') {
        task.state = 'failed'; task.blocking = false; state.active = null;
        task.error = { code: 'PREFLIGHT_INTERRUPTED', message: 'Interrupted before sending. No automatic retry.' }; await save(); return taskView(task);
      }
      const adapter = this.provider(id);
      try {
        await adapter.browser.runExclusive(async () => {
          const observed = await adapter.inspect();
          const url = canonicalURL(observed.url);
          const saved = task.conversation_url;
          const expected = saved && !adapter.isProvisional?.(saved) ? saved : canonicalURL(task.baseline.url);
          const root = adapter.isRoot(expected);
          if (url !== expected && !root) throw new WebUIError('CONVERSATION_CHANGED', 'Open the task conversation before resuming it.');
          const acknowledged = observed.userCount === task.baseline.userCount + 1 && textHash(observed.lastUser) === task.promptHash;
          if (!acknowledged) throw new WebUIError('SEND_UNCONFIRMED', 'The expected user turn is not confirmed. No resend was attempted.');
          if (!adapter.isProvisional?.(url)) task.conversation_url = url;
          if (observed.complete && observed.responseCount > task.baseline.responseCount) {
            await adapter.settle();
            task.state = 'completed'; task.blocking = false; state.active = null;
            task.response = { text: observed.text, format: 'plain_text', complete: true, model: observed.model || null, url: observed.url };
          } else if (cancel) {
            if (!observed.busy) throw new WebUIError('CANCEL_UNCONFIRMED', 'No active generation control could be confirmed. Task remains reserved.');
            await adapter.cancel();
            await adapter.settle();
            task.state = 'cancelled'; task.blocking = false; state.active = null;
            task.response = { text: observed.text || '', format: 'plain_text', complete: false, model: observed.model || null, url: observed.url };
          } else task.state = observed.busy ? 'running' : 'submitted';
          task.error = null;
        }, { signal, name: cancel ? 'chat_cancel' : 'chat_result' });
      } catch (error) {
        task.state = 'uncertain';
        task.error = { code: error.code || (signal?.aborted ? 'INTERRUPTED' : 'PROVIDER_ERROR'), message: error.message.split('\n')[0] };
      }
      task.updated_at = Date.now(); await save(); return taskView(task);
    }, signal);
  }
  async result(taskId, { wait = false, timeoutMs = 30000, signal } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new WebUIError('INVALID_TIMEOUT', 'timeoutMs must be between 1000 and 300000.');
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const task = await this.read(taskId, { signal });
      if (!wait || terminal.has(task.state) || task.state === 'uncertain' || Date.now() >= deadline) return { ...task, timed_out: wait && !terminal.has(task.state) && Date.now() >= deadline };
      // Release provider locks between observations so cancellation and status
      // from another process remain available. No background worker resends.
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
  async abandon(taskId, { confirm = false, signal } = {}) {
    if (confirm !== true) throw new WebUIError('CONFIRM_REQUIRED', 'Explicit confirmation is required to abandon tracking; this cannot undo a send.');
    const id = this.taskProvider(taskId);
    return this.locked(id, async (state, save) => {
      const task = state.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      if (terminal.has(task.state)) return taskView(task);
      await this.provider(id).browser.runExclusive(async () => {
        const adapter = this.provider(id);
        const observed = await adapter.inspect();
        const expected = task.conversation_url || task.baseline?.url;
        if (!expected || (canonicalURL(observed.url) !== canonicalURL(expected) && !adapter.isRoot(canonicalURL(expected)))) throw new WebUIError('CONVERSATION_CHANGED', 'Return to the original page before abandoning tracking.');
        if (observed.busy) throw new WebUIError('GENERATING', 'Generation is active. Use chat_cancel for the verified task.');
        await adapter.settle();
      }, { signal, name: 'chat_abandon' });
      task.state = 'abandoned'; task.blocking = false; task.updated_at = Date.now();
      task.error = { code: 'TRACKING_ABANDONED', message: 'Tracking explicitly abandoned. Delivery and completion are not asserted; the request_id remains reserved.' };
      state.active = null; await save(); return taskView(task);
    }, signal);
  }
  async list(id, limit = 20, { offset = 0, state: filter } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new WebUIError('INVALID_PAGE', 'limit must be 1..100 and offset a nonnegative integer.');
    if (filter && !['preparing', 'submitting', 'submitted', 'running', 'uncertain', ...terminal].includes(filter)) throw new WebUIError('INVALID_STATE', 'Unknown task state.');
    return this.locked(id, async (state) => {
      const tasks = Object.values(state.tasks).filter((task) => !filter || task.state === filter).sort((a, b) => b.created_at - a.created_at || a.task_id.localeCompare(b.task_id));
      return { provider: id, active_task: state.active, total: tasks.length, offset, next_offset: offset + limit < tasks.length ? offset + limit : null, tasks: tasks.slice(offset, offset + limit).map((task) => {
        const view = taskView(task); delete view.response; return view;
      }) };
    });
  }
}
