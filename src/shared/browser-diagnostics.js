import fs from 'node:fs/promises';
import path from 'node:path';

const queues = new Map();
const fields = ['pid', 'exitCode', 'signal', 'durationMs', 'expected', 'errorName'];
// Deliberate allowlist: never persist page URLs, target IDs, error messages,
// browser stderr, account data or any user/page content.
export function browserDiagnostics(stateFile) {
  const file = path.join(path.dirname(stateFile), 'browser-diagnostics.jsonl');
  return (event, data = {}) => {
    const entry = { at: new Date().toISOString(), event };
    for (const key of fields) if (data[key] !== undefined) entry[key] = data[key];
    const next = (queues.get(file) || Promise.resolve()).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      if ((await fs.stat(file).catch(() => null))?.size > 512 * 1024) {
        await fs.rename(file, file + '.1').catch(() => {});
      }
      await fs.appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }).catch(() => {});
    queues.set(file, next);
    void next.finally(() => { if (queues.get(file) === next) queues.delete(file); });
    return next;
  };
}
