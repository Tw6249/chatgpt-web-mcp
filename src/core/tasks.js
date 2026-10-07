import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, readState, writeState, WebUIError } from '../shared/persistent-browser.js';
import { recoveryFor } from './recovery.js';
import { validateSessionId } from '../shared/sessions.js';

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
  if (!state || ![1, 2].includes(state.version) || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks) ||
      (state.active !== null && (typeof state.active !== 'string' || !state.tasks[state.active] || terminal.has(state.tasks[state.active].state))) ||
      Object.entries(state.tasks).some(([key, task]) => !task || task.task_id !== key || task.provider !== id ||
        !['preparing', 'submitting', 'submitted', 'running', 'uncertain', ...terminal].includes(task.state) ||
        (state.version === 1 && task.session_id !== undefined) ||
        (!terminal.has(task.state) && !task.session_id && state.active !== key))) throw new WebUIError('INVALID_JOURNAL', 'Unsupported or damaged task journal; nothing was sent.');
  const scopes = new Set();
  for (const task of Object.values(state.tasks)) {
    try { validateSessionId(task.session_id); } catch { throw new WebUIError('INVALID_JOURNAL', 'Invalid task session.'); }
    if (!terminal.has(task.state)) {
      const scope = task.session_id || '';
      if (scopes.has(scope)) throw new WebUIError('INVALID_JOURNAL', 'Multiple active tasks share one session.');
      scopes.add(scope);
    }
  }
  if (state.active && state.tasks[state.active].session_id) throw new WebUIError('INVALID_JOURNAL', 'Invalid legacy active task.');
  return state;
}

const activeIn = (state, sessionId) => Object.values(state.tasks).find(t => !terminal.has(t.state) && t.session_id === sessionId);
const releaseTask = (state, task) => { if (state.active === task.task_id) state.active = null; };

// Journal and brief UI operations are serialized per provider. Generation and
// task occupancy are isolated by session; result waits release the lock.
export class TaskKernel {
  constructor(providers, { directory = process.env.WEB_CHAT_DATA_DIR || path.join(os.homedir(), '.web-chat-mcp') } = {}) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.directory = path.resolve(directory);
    this.sessions = new Map();
  }
  adapter(id, sessionId) {
    const provider = this.provider(id);
    validateSessionId(sessionId);
    if (!sessionId) return provider;
    if (!provider.forSession) throw new WebUIError('SESSIONS_UNSUPPORTED', 'This provider does not support isolated sessions.');
    const key = `${id}:${sessionId}`;
    if (!this.sessions.has(key)) this.sessions.set(key, provider.forSession(sessionId));
    return this.sessions.get(key);
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
    const release = await acquireLock(`${file}.lock`, { signal, timeout: 180000 });
    try {
      const raw = await readState(file);
      const state = validateJournal(raw, id);
      const save = () => writeState(file, state);
      return await fn(state, save);
    } finally { await release(); }
  }
  async run(id, fn, { signal, readOnly = false, name = 'unified-operation', sessionId, conversationChanged = false } = {}) {
    const adapter = this.adapter(id, sessionId);
    return this.locked(id, async (state, save) => {
      const active = activeIn(state, sessionId);
      if (active && !readOnly) throw new WebUIError('TASK_ACTIVE', `Session has task ${active.task_id}. Use chat_result or chat_cancel, or use a different session_id for independent work.`);
      const result = await adapter.browser.runExclusive(() => fn(adapter.browser), { signal, name });
      if (conversationChanged && sessionId) { state.sessionNavigations = { ...state.sessionNavigations, [sessionId]: Date.now() }; await save(); }
      return result;
    }, signal);
  }
  async send({ provider: id, request_id, prompt, files = [], model, newConversation = false, session_id, answer_tier, web_search = false }, { signal } = {}) {
    const adapter = this.adapter(id, session_id);
    if (typeof request_id !== 'string' || !request_id.trim() || request_id.length > 128) throw new WebUIError('INVALID_REQUEST_ID', 'A nonempty request_id of at most 128 characters is required. Reuse it after a timeout.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new WebUIError('EMPTY_PROMPT', 'Prompt must not be blank.');
    if (!Array.isArray(files) || files.length > 10 || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw new WebUIError('INVALID_FILES', 'Use at most ten absolute local file paths.');
    const requestHash = fingerprint(request_id);
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new WebUIError('INVALID_MODEL', 'model must be a nonempty exact name.');
    if (answer_tier !== undefined && (typeof answer_tier !== 'string' || !answer_tier.trim())) throw new WebUIError('INVALID_TIER', 'answer_tier must be an exact available tier.');
    if (typeof web_search !== 'boolean') throw new WebUIError('INVALID_SEARCH', 'web_search must be a boolean.');
    if ((answer_tier || web_search) && id !== 'chatgpt') throw new WebUIError('UNSUPPORTED_SETTING', 'answer_tier and web_search currently require ChatGPT.');
    const payloadHash = fingerprint({ prompt, files, ...(model ? { model } : {}), ...(newConversation ? { newConversation: true } : {}), ...(session_id ? { session_id } : {}), ...(answer_tier ? { answer_tier } : {}), ...(web_search ? { web_search } : {}) });
    return this.locked(id, async (state, save) => {
      const existing = Object.values(state.tasks).find((task) => task.requestHash === requestHash);
      if (existing) {
        if (existing.fingerprint !== payloadHash) throw new WebUIError('IDEMPOTENCY_CONFLICT', 'This request_id was already used with different content.');
        return { ...taskView(existing), replayed: true };
      }
      const active = activeIn(state, session_id);
      if (active) throw new WebUIError('TASK_ACTIVE', `Session has task ${active.task_id}; do not resend. Use a different session_id for independent work.`);
      // Even an unbound/uncertain send reserves only its own target. Browser
      // adapters pin named sessions by CDP target ID and exclude those targets
      // from legacy selection. The conversation-identity guard below still
      // prevents two sessions from writing into the same known conversation.
      const task = { task_id: `${id}:${randomUUID()}`, provider: id, ...(session_id ? { session_id } : {}), state: 'preparing', requestHash, fingerprint: payloadHash, promptHash: textHash(prompt), created_at: Date.now(), updated_at: Date.now(), blocking: true, response: null, error: null };
      state.tasks[task.task_id] = task;
      if (session_id) state.version = 2; else state.active = task.task_id;
      await save();
      try {
        for (const file of files) {
          if (!(await fs.stat(file)).isFile()) throw new WebUIError('INVALID_FILES', 'Attachment must be a regular file.');
          await fs.access(file, fs.constants.R_OK);
        }
        await adapter.browser.runExclusive(async () => {
          if (newConversation) await adapter.browser.newChat();
          else if (session_id && adapter.restore) {
            const previous = Object.values(state.tasks).filter(t => t.task_id !== task.task_id && t.session_id === session_id && t.conversation_url).sort((a, b) => b.created_at - a.created_at)[0];
            if (previous && !(state.sessionNavigations?.[session_id] >= previous.created_at)) await adapter.restore(previous.conversation_url);
          }
          if (model) await adapter.browser.selectModel(model);
          task.baseline = await adapter.prepare();
          const baselineURL = canonicalURL(task.baseline.url);
          if (!adapter.isRoot(baselineURL) && !adapter.isProvisional?.(baselineURL) && Object.values(state.tasks).some(other => other.task_id !== task.task_id && !terminal.has(other.state) && [other.conversation_url, other.baseline?.url].some(url => url && canonicalURL(url) === baselineURL))) {
            throw new WebUIError('CONVERSATION_ACTIVE', 'Another session has an active task in this conversation. Use a new conversation for independent work.');
          }
          if (answer_tier) task.answer_tier = await adapter.browser.selectAnswerTier(answer_tier);
          if (web_search) await adapter.browser.enableWebSearch();
          // Persist before the first possible send. A crash from this point on
          // must be reconciled from the page, never retried automatically.
          task.state = 'submitting'; task.updated_at = Date.now(); await save();
          const sent = await adapter.send({ prompt, files });
          task.state = 'submitted'; task.submitted_at = Date.now(); task.updated_at = task.submitted_at;
          const acknowledgement = adapter.restore ? await adapter.inspect() : null;
          const identityConfirmed = !acknowledgement || (acknowledgement.userCount === task.baseline.userCount + 1 && textHash(acknowledgement.lastUser) === task.promptHash);
          const sentURL = acknowledgement?.url || sent.url;
          if (identityConfirmed && sentURL && !adapter.isRoot(canonicalURL(sentURL)) && !adapter.isProvisional?.(sentURL)) task.conversation_url = canonicalURL(sentURL);
          await save();
        }, { signal, name: 'chat_send' });
      } catch (error) {
        task.state = task.state === 'preparing' ? 'failed' : 'uncertain';
        task.blocking = task.state !== 'failed';
        task.error = { code: error.code || (signal?.aborted ? 'INTERRUPTED' : 'PROVIDER_ERROR'), message: error.message.split('\n')[0] };
        task.updated_at = Date.now(); if (!task.blocking) releaseTask(state, task);
        await save();
      }
      return taskView(task);
    }, signal);
  }
  async retry(taskId, { signal } = {}) {
    const id = this.taskProvider(taskId);
    return this.locked(id, async (state, save) => {
      const task = state.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      // Persist a single attempt per task so reconnects never repeat a click.
      if (task.retry_count) return { ...taskView(task), replayed: true };
      const adapter = this.adapter(id, task.session_id);
      if (!adapter.prepareRetry) throw new WebUIError('RETRY_UNSUPPORTED', 'This provider does not support verified response retry.');
      if (task.state !== 'completed' || !task.response?.complete) throw new WebUIError('RETRY_NOT_COMPLETED', 'Retry requires a completed answer, not an uncertain send or running generation.');
      if (Object.values(state.tasks).some(t => t.task_id !== taskId && t.session_id === task.session_id && (t.created_at >= task.created_at || !terminal.has(t.state)))) throw new WebUIError('TASK_SUPERSEDED', 'A later or active task occupies this session.');
      await adapter.browser.runExclusive(async () => {
        const observed = await adapter.inspect();
        const expected = task.conversation_url || task.response.url;
        if (!expected || canonicalURL(observed.url) !== canonicalURL(expected)) throw new WebUIError('CONVERSATION_CHANGED', 'Open the original task conversation before retrying.');
        if (Object.values(state.tasks).some(t => t.task_id !== taskId && !terminal.has(t.state) && [t.conversation_url, t.baseline?.url].some(url => url && canonicalURL(url) === canonicalURL(expected)))) throw new WebUIError('CONVERSATION_ACTIVE', 'Another task is using this conversation.');
        if (observed.busy || !observed.complete || observed.userCount !== task.baseline.userCount + 1 || textHash(observed.lastUser) !== task.promptHash || observed.text !== task.response.text) throw new WebUIError('RETRY_TARGET_CHANGED', 'The page no longer matches the completed task response.');
        if (task.response.model && observed.model !== task.response.model) throw new WebUIError('RETRY_MODEL_CHANGED', 'The selected model or thinking setting changed; restore it before retrying.');
        const clickRetry = await adapter.prepareRetry(observed);
        task.previous_response = task.response; task.response = null;
        task.retry_count = 1; task.retry_started_at = Date.now(); task.retry_activity = false;
        task.state = 'submitting'; task.blocking = true; task.error = null;
        if (!task.session_id) state.active = taskId;
        task.updated_at = Date.now(); await save();
        try {
          const result = await clickRetry();
          task.retry_activity = result.started === true;
          task.state = 'submitted';
        } catch (error) {
          task.state = 'uncertain';
          task.error = { code: error.code || 'RETRY_UNCONFIRMED', message: error.message.split('\n')[0] };
        }
        task.updated_at = Date.now(); await save();
      }, { signal, name: 'chat_retry' });
      return taskView(task);
    }, signal);
  }

  async read(taskId, { signal, cancel = false, refresh = false, conversation_url } = {}) {
    const id = this.taskProvider(taskId);
    return this.locked(id, async (state, save) => {
      const task = state.tasks[taskId];
      if (!task) throw new WebUIError('TASK_NOT_FOUND', 'Task not found.');
      const revalidate = refresh && task.state === 'completed' && !cancel;
      if (terminal.has(task.state) && !revalidate) return taskView(task);
      if (revalidate) {
        if (Object.values(state.tasks).some(t => t.task_id !== taskId && t.session_id === task.session_id && (t.created_at >= task.created_at || !terminal.has(t.state)))) throw new WebUIError('TASK_SUPERSEDED', 'A later task uses this session. The cached result is preserved; inspect history separately.');
        task.previous_response = task.response;
        task.response = null; task.state = 'uncertain'; task.blocking = true;
        if (!task.session_id) state.active = taskId;
        await save();
      }
      if (task.state === 'preparing') {
        task.state = 'failed'; task.blocking = false; releaseTask(state, task);
        task.error = { code: 'PREFLIGHT_INTERRUPTED', message: 'Interrupted before sending. No automatic retry.' }; await save(); return taskView(task);
      }
      const adapter = this.adapter(id, task.session_id);
      try {
        await adapter.browser.runExclusive(async () => {
          const saved = task.conversation_url;
          const known = saved && !adapter.isProvisional?.(saved) ? saved : canonicalURL(task.baseline.url);
          const unresolved = adapter.isRoot(known) || adapter.isProvisional?.(known);
          if (conversation_url && !unresolved && canonicalURL(conversation_url) !== known) throw new WebUIError('CONVERSATION_CONFLICT', 'Recovery URL disagrees with the saved task conversation.');
          const expected = conversation_url ? canonicalURL(conversation_url) : known;
          const root = adapter.isRoot(expected) || adapter.isProvisional?.(expected);
          if (!root && adapter.restore && (task.session_id || conversation_url || revalidate)) await adapter.restore(expected);
          const observed = await adapter.inspect();
          const url = canonicalURL(observed.url);
          if (url !== expected && !root) throw new WebUIError('CONVERSATION_CHANGED', 'Open the task conversation before resuming it.');
          const acknowledged = observed.userCount === task.baseline.userCount + 1 && textHash(observed.lastUser) === task.promptHash;
          // UI acknowledgement may arrive after submitPrompt(wait:false).
          // Briefly keep observing an unchanged baseline, without a retry.
          if (!acknowledged && !cancel && task.state === 'submitted' && task.submitted_at && Date.now() - task.submitted_at < 20000 && observed.userCount === task.baseline.userCount && observed.responseCount === task.baseline.responseCount) return;
          if (!acknowledged) throw new WebUIError('SEND_UNCONFIRMED', 'The expected user turn is not confirmed. No resend was attempted.');
          if (!adapter.isProvisional?.(url)) task.conversation_url = url;
          if (task.retry_count && !task.retry_activity) {
            if (observed.busy || (observed.text && observed.text !== task.previous_response?.text)) task.retry_activity = true;
            else throw new WebUIError('RETRY_UNCONFIRMED', 'Only the previous answer is visible; retry completion is not confirmed. Do not click again.');
          }
          if (observed.complete && observed.responseCount > task.baseline.responseCount) {
            await adapter.settle();
            task.state = 'completed'; task.blocking = false; releaseTask(state, task);
            task.response = { text: observed.text, format: 'plain_text', complete: true, model: observed.model || null, url: observed.url };
          } else if (cancel) {
            if (!observed.busy) throw new WebUIError('CANCEL_UNCONFIRMED', 'No active generation control could be confirmed. Task remains reserved.');
            await adapter.cancel();
            await adapter.settle();
            task.state = 'cancelled'; task.blocking = false; releaseTask(state, task);
            task.response = { text: observed.text || '', format: 'plain_text', complete: false, model: observed.model || null, url: observed.url };
          } else { task.state = observed.busy ? 'running' : 'submitted'; task.blocking = true; }
          task.error = null;
        }, { signal, name: cancel ? 'chat_cancel' : 'chat_result' });
      } catch (error) {
        task.state = 'uncertain';
        task.error = { code: error.code || (signal?.aborted ? 'INTERRUPTED' : 'PROVIDER_ERROR'), message: error.message.split('\n')[0] };
      }
      task.updated_at = Date.now(); await save(); return taskView(task);
    }, signal);
  }
  async result(taskId, { wait = false, timeoutMs = 30000, signal, refresh = false, conversation_url } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new WebUIError('INVALID_TIMEOUT', 'timeoutMs must be between 1000 and 300000.');
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const task = await this.read(taskId, { signal, refresh, conversation_url });
      refresh = false;
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
      const adapter = this.adapter(id, task.session_id);
      await adapter.browser.runExclusive(async () => {
        const observed = await adapter.inspect({ allowPageError: true });
        const saved = task.conversation_url;
        const expected = saved && !adapter.isProvisional?.(saved) ? saved : task.baseline?.url;
        if (!expected || (canonicalURL(observed.url) !== canonicalURL(expected) && !adapter.isRoot(canonicalURL(expected)))) throw new WebUIError('CONVERSATION_CHANGED', 'Return to the original page before abandoning tracking.');
        if (observed.busy) throw new WebUIError('GENERATING', 'Generation is active. Use chat_cancel for the verified task.');
        await adapter.settle();
      }, { signal, name: 'chat_abandon' });
      task.state = 'abandoned'; task.blocking = false; task.updated_at = Date.now();
      task.error = { code: 'TRACKING_ABANDONED', message: 'Tracking explicitly abandoned. Delivery and completion are not asserted; the request_id remains reserved.' };
      releaseTask(state, task); await save(); return taskView(task);
    }, signal);
  }
  async list(id, limit = 20, { offset = 0, state: filter } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new WebUIError('INVALID_PAGE', 'limit must be 1..100 and offset a nonnegative integer.');
    if (filter && !['preparing', 'submitting', 'submitted', 'running', 'uncertain', ...terminal].includes(filter)) throw new WebUIError('INVALID_STATE', 'Unknown task state.');
    return this.locked(id, async (state) => {
      const tasks = Object.values(state.tasks).filter((task) => !filter || task.state === filter).sort((a, b) => b.created_at - a.created_at || a.task_id.localeCompare(b.task_id));
      return { provider: id, active_task: state.active, active_tasks: Object.values(state.tasks).filter(t => !terminal.has(t.state)).map(t => ({ task_id: t.task_id, session_id: t.session_id || null, state: t.state })), total: tasks.length, offset, next_offset: offset + limit < tasks.length ? offset + limit : null, tasks: tasks.slice(offset, offset + limit).map((task) => {
        const view = taskView(task); delete view.response; delete view.previous_response; return view;
      }) };
    });
  }
  async findRequest(id, requestId) {
    return this.locked(id, (state) => {
      const task = Object.values(state.tasks).find((task) => task.requestHash === fingerprint(requestId));
      return task ? taskView(task) : null;
    });
  }
}
