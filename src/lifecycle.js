import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { diagnose } from './core/diagnostics.js';
import { Installer } from './maintenance.js';
import { startPanel } from './panel.js';
import { WebUIError } from './shared/persistent-browser.js';

export const lifecycleCommands = ['setup', 'upgrade', 'rollback', 'panel', 'report', 'login'];
export function parseLifecycle(command, args) {
  const options = {
    setup: { ref: { type: 'string', default: 'main' } }, upgrade: { ref: { type: 'string', default: 'main' } }, rollback: {},
    panel: { port: { type: 'string', default: '0' } }, report: { out: { type: 'string' } },
    login: { provider: { type: 'string', default: 'all' }, timeout: { type: 'string', default: '900000' } },
  };
  if (!Object.hasOwn(options, command)) throw new Error('Unknown command.');
  const { values } = parseArgs({ args, options: options[command], strict: true, allowPositionals: false });
  if (values.provider && !['all', 'chatgpt', 'gemini'].includes(values.provider)) throw new Error('Select --provider all, chatgpt or gemini.');
  if (values.out && !path.isAbsolute(values.out)) throw new Error('--out requires an absolute path. Existing files are never overwritten.');
  for (const [key, min, max] of [['port', 0, 65535], ['timeout', 1000, 900000]]) {
    if (values[key] !== undefined) {
      if (!/^\d+$/.test(values[key]) || Number(values[key]) < min || Number(values[key]) > max) throw new Error(`Invalid --${key}.`);
      values[key] = Number(values[key]);
    }
  }
  return values;
}
export async function assertMaintenanceIdle(kernel) {
  const report = await diagnose(kernel);
  if (report.providers.some((p) => p.checks.some((c) => ['TASK_ACTIVE', 'PENDING', 'IN_USE', 'UNREADABLE_LOCK', 'INVALID_JOURNAL', 'UNREADABLE_STATE'].includes(c.code)))) throw new WebUIError('MAINTENANCE_BLOCKED', 'Resolve active tasks or invalid local state before switching versions. Use doctor and tasks.');
}
export async function loginProviders(kernel, { provider = 'all', timeout = 900000 } = {}, signal) {
  const ids = provider === 'all' ? [...kernel.providers.keys()] : [provider];
  const results = [];
  for (const id of ids) {
    const browser = kernel.provider(id).browser;
    const deadline = Date.now() + timeout;
    console.error(`Sign in manually in the dedicated ${id} window if needed. Browser will remain open.`);
    while (true) {
      const signedIn = await kernel.run(id, async () => {
        await browser.page();
        return id === 'chatgpt' ? browser.signedIn() : (await browser.snapshot()).signedIn;
      }, { signal, name: 'login' });
      if (signedIn) { results.push({ provider: id, signed_in: true }); break; }
      if (Date.now() >= deadline) throw new WebUIError('LOGIN_TIMEOUT', `Manual login timed out for ${id}. Run login again when ready.`);
      await delay(Math.min(5000, deadline - Date.now()), undefined, { signal });
    }
  }
  return { providers: results };
}
export async function runLifecycle(command, args) {
  let input;
  try { input = parseLifecycle(command, args); }
  catch (error) { console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', error: error.message })); process.exitCode = 2; return; }
  const { createRuntime } = await import('./core/runtime.js');
  const runtime = createRuntime();
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    let result;
    if (['setup', 'upgrade', 'rollback'].includes(command)) {
      await assertMaintenanceIdle(runtime.kernel);
      const installer = new Installer({ beforeActivate: () => assertMaintenanceIdle(runtime.kernel) });
      console.error('Preparing managed release; existing checkout and browser profiles are preserved.');
      result = command === 'rollback' ? await installer.rollback({ signal: controller.signal }) : await installer.install({ ...input, signal: controller.signal });
    } else if (command === 'login') result = await loginProviders(runtime.kernel, input, controller.signal);
    else if (command === 'report') {
      result = { generated_at: new Date().toISOString(), ...await diagnose(runtime.kernel) };
      if (input.out) { await fs.writeFile(input.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); result = { saved: input.out, redacted: true }; }
    } else if (command === 'panel') {
      const panel = await startPanel(runtime.kernel, input);
      console.log(JSON.stringify({ url: panel.url, scope: 'loopback_read_only', stop: 'Ctrl+C' }));
      try { if (!controller.signal.aborted) await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true })); }
      finally { await panel.close(); }
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (result?.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ code: error.code || 'LIFECYCLE_ERROR', error: error.message })); process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); await runtime.close(); }
}
