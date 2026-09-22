import { parseArgs } from 'node:util';
import { diagnose } from './core/diagnostics.js';

export const managementCommands = ['providers', 'doctor', 'tasks', 'result', 'cancel', 'abandon'];
export function parseManagement(command, args) {
  const schemas = {
    providers: {}, doctor: { provider: { type: 'string', default: 'all' } },
    tasks: { provider: { type: 'string', default: 'all' }, limit: { type: 'string', default: '20' }, offset: { type: 'string', default: '0' }, state: { type: 'string' } },
    result: { wait: { type: 'boolean', default: false }, timeout: { type: 'string', default: '30000' } },
    cancel: {}, abandon: { confirm: { type: 'boolean', default: false } },
  };
  if (!Object.hasOwn(schemas, command)) throw new Error('Unknown management command.');
  const { values, positionals } = parseArgs({ args, options: schemas[command], allowPositionals: true, strict: true });
  const needsId = ['result', 'cancel', 'abandon'].includes(command);
  if (positionals.length !== (needsId ? 1 : 0)) throw new Error(needsId ? 'Exactly one task_id is required.' : 'Unexpected positional arguments.');
  if (needsId && !/^(chatgpt|gemini):[0-9a-f-]{36}$/.test(positionals[0])) throw new Error('Invalid task_id.');
  if (values.provider && !['chatgpt', 'gemini', 'all'].includes(values.provider)) throw new Error('--provider must be chatgpt, gemini or all.');
  for (const [key, min, max] of [['limit', 1, 100], ['offset', 0, Number.MAX_SAFE_INTEGER], ['timeout', 1000, 300000]]) {
    if (values[key] !== undefined) {
      if (!/^\d+$/.test(values[key])) throw new Error(`--${key} must be an integer.`);
      values[key] = Number(values[key]);
      if (!Number.isSafeInteger(values[key]) || values[key] < min || values[key] > max) throw new Error(`--${key} must be ${min}..${max}.`);
    }
  }
  if (values.state && !['preparing', 'submitting', 'submitted', 'running', 'uncertain', 'completed', 'cancelled', 'failed', 'abandoned'].includes(values.state)) throw new Error('Unknown --state.');
  if (command === 'abandon' && !values.confirm) throw new Error('Use --confirm only after inspecting the idle original page; abandonment does not undo delivery.');
  return { command, ...values, task_id: positionals[0] };
}

export async function executeManagement(kernel, input, signal) {
  const { command, task_id } = input;
  const ids = input.provider && input.provider !== 'all' ? [input.provider] : [...kernel.providers.keys()];
  if (command === 'providers') return { providers: [...kernel.providers.values()].map(({ id, capabilities }) => ({ id, capabilities })) };
  if (command === 'doctor') return diagnose(kernel, ids);
  if (command === 'tasks') return { providers: await Promise.all(ids.map((id) => kernel.list(id, input.limit, input))) };
  if (command === 'result') return kernel.result(task_id, { wait: input.wait, timeoutMs: input.timeout, signal });
  if (command === 'cancel') return kernel.read(task_id, { cancel: true, signal });
  if (command === 'abandon') return kernel.abandon(task_id, { confirm: input.confirm, signal });
  throw new Error('Unknown management command.');
}

export async function runManagement(command, args) {
  let input;
  try { input = parseManagement(command, args); }
  catch (error) { console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', error: error.message })); process.exitCode = 2; return; }
  const { createRuntime } = await import('./core/runtime.js');
  const runtime = createRuntime();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await executeManagement(runtime.kernel, input, controller.signal);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false || ['uncertain', 'failed'].includes(result.state) || result.timed_out) process.exitCode = 1;
    if (controller.signal.aborted) process.exitCode = 130;
  } catch (error) {
    console.error(JSON.stringify({ code: error.code || 'MANAGEMENT_ERROR', error: error.message })); process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await runtime.close();
  }
}
