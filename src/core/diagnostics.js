import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, processAlive } from '../shared/persistent-browser.js';
import { validateJournal } from './tasks.js';

async function localState(file) {
  const state = await readState(file);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid local state');
  return state;
}

// Read-only local inspection: no locks created, no browser launch, no page access.
// Only allowlisted fields leave this module. Raw paths, URLs, replies and errors
// may contain personal information and must never appear in this report.
export async function diagnose(kernel, ids = [...kernel.providers.keys()]) {
  const providers = await Promise.all(ids.map(async (id) => {
    const adapter = kernel.provider(id);
    const config = adapter.localConfig;
    const checks = [];
    const check = (name, status, code, action) => checks.push({ name, status, code, action });
    try {
      if (!config?.executable || !(await fs.stat(config.executable)).isFile()) throw new Error();
      check('browser_executable', 'pass', 'AVAILABLE', 'none');
    } catch { check('browser_executable', 'fail', 'NO_BROWSER', 'Install Chrome/Edge or configure the provider executable.'); }
    try {
      const runtime = await localState(config.runtimeState);
      check('runtime_state', runtime.circuitBreaker?.active ? 'warn' : 'pass', runtime.circuitBreaker?.active ? 'RATE_LIMITED' : 'READABLE', runtime.circuitBreaker?.active ? 'Wait for manual provider recovery; never automatically retry.' : 'none');
      if (runtime.pending || runtime.activeGeneration?.active) check('provider_pending', 'warn', 'PENDING', 'Inspect the existing answer before sending a new request.');
    } catch { check('runtime_state', 'fail', 'UNREADABLE_STATE', 'Inspect the local state privately; do not delete it to retry.'); }
    try {
      const browser = await localState(config.browserState);
      check('browser_process', 'info', processAlive(browser.pid) ? 'RUNNING_UNVERIFIED' : 'NOT_RUNNING', 'Local PID check only; sign-in and browser connectivity are not verified.');
    } catch { check('browser_process', 'fail', 'UNREADABLE_STATE', 'Inspect local browser state privately.'); }
    for (const [name, file] of [['operation_lock', config?.operationLock], ['task_lock', path.join(kernel.directory, id, 'tasks.json.lock')]]) {
      if (!file) continue;
      try {
        const owner = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!Number.isInteger(owner?.pid) || owner.pid < 1 || !owner.token) throw new Error();
        check(name, 'warn', processAlive(owner.pid) ? 'IN_USE' : 'STALE_OWNER', 'Snapshot only. Wait for ongoing work; do not delete locks blindly.');
      } catch (error) {
        if (error.code === 'ENOENT') check(name, 'pass', 'AVAILABLE', 'none');
        else check(name, 'warn', 'UNREADABLE_LOCK', 'Lock may be initializing or damaged. Inspect locally before changing it.');
      }
    }
    try {
      const journal = validateJournal(await readState(path.join(kernel.directory, id, 'tasks.json')), id);
      const counts = {};
      for (const task of Object.values(journal.tasks)) counts[task.state] = (counts[task.state] || 0) + 1;
      checks.push({ name: 'task_journal', status: journal.active ? 'warn' : 'pass', code: journal.active ? 'TASK_ACTIVE' : 'READABLE', counts, active_state: journal.active ? journal.tasks[journal.active].state : null, action: journal.active ? 'Use chat_tasks, then chat_result for the active task. Do not resend.' : 'none' });
    } catch { check('task_journal', 'fail', 'INVALID_JOURNAL', 'Inspect and restore the local journal privately; preserve duplicate-request records.'); }
    return { provider: id, ok: !checks.some((item) => item.status === 'fail'), checks };
  }));
  const nodeOK = Number(process.versions.node.split('.')[0]) >= 20;
  return { schema_version: 1, scope: 'local_only', sign_in_verified: false, node: { version: process.version, ok: nodeOK }, ok: nodeOK && providers.every((p) => p.ok), providers };
}
