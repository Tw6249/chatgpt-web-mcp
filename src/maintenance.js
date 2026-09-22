import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock, readState, writeState, WebUIError } from './shared/persistent-browser.js';
const exec = promisify(execFile);
const source = 'https://github.com/Tw6249/chatgpt-web-mcp.git';
const validSHA = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);
export const installDirectory = () => path.resolve(process.env.WEB_CHAT_INSTALL_DIR || path.join(os.homedir(), '.web-chat-mcp', 'install'));

export async function runCommand(command, args, cwd, { signal } = {}) {
  // The Windows shell is used only for fixed npm commands, never interpolated input.
  if (command === 'npm' && process.platform === 'win32') {
    const allowed = { ci: 'npm ci --ignore-scripts --no-audit --no-fund', test: 'npm test', smoke: 'npm run smoke' };
    const key = args[0] === 'run' ? args[1] : args[0];
    if (!allowed[key]) throw new Error('Unsupported npm operation');
    return exec('cmd.exe', ['/d', '/s', '/c', allowed[key]], { cwd, signal, windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  }
  return exec(command, args, { cwd, signal, windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
}

export class Installer {
  constructor({ directory = installDirectory(), run = runCommand, beforeActivate = async () => {} } = {}) { this.directory = path.resolve(directory); this.run = run; this.beforeActivate = beforeActivate; }
  async manifest() {
    const value = await readState(path.join(this.directory, 'active.json'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.keys(value).length && (!validSHA(value.current) || (value.previous !== null && !validSHA(value.previous)) || (value.manager !== undefined && !validSHA(value.manager))))) throw new WebUIError('INVALID_INSTALL', 'Invalid installation manifest; inspect it locally.');
    return value;
  }
  async launcher() {
    const file = path.join(this.directory, 'launch.mjs');
    await fs.mkdir(this.directory, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `import fs from 'node:fs/promises';
const state=JSON.parse(await fs.readFile(new URL('./active.json',import.meta.url),'utf8'));
const revision=['setup','upgrade','rollback'].includes(process.argv[2])?(state.manager||state.current):state.current;
if(!/^[a-f0-9]{40}$/.test(revision))throw Error('Invalid installation manifest');
await import(new URL('./releases/'+revision+'/src/cli.js',import.meta.url));
`, { mode: 0o600 });
    await fs.rename(temp, file);
    return file;
  }
  async verifyRelease(directory, sha, signal) {
    const actual = (await this.run('git', ['rev-parse', 'HEAD'], directory, { signal })).stdout.trim();
    const dirty = (await this.run('git', ['status', '--porcelain', '--untracked-files=no'], directory, { signal })).stdout.trim();
    if (actual !== sha || dirty) throw new WebUIError('MODIFIED_RELEASE', 'Managed release has changed; refusing to activate it.');
  }
  async install({ ref = 'main', signal } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(ref) || ref.includes('..')) throw new WebUIError('INVALID_REF', 'Use a branch, tag or commit from the maintained repository.');
    const release = await acquireLock(path.join(this.directory, 'maintenance.lock'), { timeout: 1000, signal });
    const run = (...args) => this.run(...args, { signal });
    let stage = 'prepare';
    try {
      const previous = await this.manifest();
      const candidate = path.join(this.directory, 'staging', randomUUID());
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      stage = 'download';
      await run('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', source, candidate], this.directory);
      if (ref !== 'main') { await run('git', ['fetch', '--depth', '1', 'origin', ref], candidate); await run('git', ['checkout', '--detach', 'FETCH_HEAD'], candidate); }
      const sha = (await run('git', ['rev-parse', 'HEAD'], candidate)).stdout.trim();
      if (!validSHA(sha)) throw new Error('Invalid downloaded revision');
      stage = 'dependencies'; await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], candidate);
      stage = 'unit_tests'; await run('npm', ['test'], candidate);
      stage = 'mcp_smoke'; await run('npm', ['run', 'smoke'], candidate);
      const pkg = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
      stage = 'activate';
      const destination = path.join(this.directory, 'releases', sha);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      // Existing releases are immutable. Never overwrite or delete a previous version.
      try { await fs.access(destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await fs.rename(candidate, destination); }
      await this.verifyRelease(destination, sha, signal);
      const launch = await this.launcher();
      signal?.throwIfAborted(); await this.beforeActivate();
      let manager = previous.manager || sha;
      try { await fs.access(path.join(destination, 'src', 'lifecycle.js')); manager = sha; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const state = { version: 1, current: sha, manager, previous: previous.current && previous.current !== sha ? previous.current : previous.previous || null, package_version: pkg.version, activated_at: Date.now(), source };
      const mcp_config = { command: process.execPath, args: [launch, 'serve'] };
      await writeState(path.join(this.directory, 'mcp-config.json'), { mcpServers: { 'web-chat': mcp_config } });
      await writeState(path.join(this.directory, 'active.json'), state);
      return { ...state, restart_required: true, mcp_config };
    } catch (error) {
      await fs.writeFile(path.join(this.directory, 'install-debug.log'), String(error.stderr || error.message), { mode: 0o600 });
      await writeState(path.join(this.directory, 'last-failure.json'), { stage, code: 'INSTALL_FAILED', at: Date.now(), current_preserved: true, exit_code: Number.isInteger(error.code) ? error.code : null });
      throw new WebUIError('INSTALL_FAILED', `Installation stopped at ${stage}; active version unchanged. Inspect local staging data or run doctor. No raw command output is included in this report.`);
    } finally { await release(); }
  }
  async rollback({ signal } = {}) {
    const release = await acquireLock(path.join(this.directory, 'maintenance.lock'), { timeout: 1000, signal });
    try {
      const state = await this.manifest();
      if (!state.previous) throw new WebUIError('NO_ROLLBACK', 'No previous managed version is available.');
      const directory = path.join(this.directory, 'releases', state.previous);
      const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      await this.verifyRelease(directory, state.previous, signal);
      await this.run('npm', ['run', 'smoke'], directory, { signal });
      signal?.throwIfAborted(); await this.beforeActivate();
      const next = { ...state, current: state.previous, previous: state.current, package_version: pkg.version, activated_at: Date.now() };
      await writeState(path.join(this.directory, 'active.json'), next);
      return { ...next, restart_required: true };
    } finally { await release(); }
  }
}
