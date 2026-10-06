import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Installer, validateUpgradeReport } from '../src/maintenance.js';
import { parseLifecycle } from '../src/lifecycle.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const readableReport = () => ({ok:true,providers:['chatgpt','gemini'].map(provider=>({provider,checks:[{name:'task_journal',status:'pass',code:'READABLE'}]}))});

test('managed install switches atomically, failed validation preserves version, rollback verifies previous', async (t) => {
  const root = path.resolve(os.tmpdir()); const directory = await fs.mkdtemp(path.join(root, 'mcp-installer-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  let sha = 'a'.repeat(40), fail = false; const commands = [];
  const run = async (cmd, args, cwd) => {
    commands.push([cmd, ...args]);
    if (cmd === process.execPath) return {stdout:JSON.stringify(readableReport())};
    if (cmd === 'git' && args[0] === 'clone') { await fs.mkdir(args.at(-1), { recursive: true }); await fs.writeFile(path.join(args.at(-1), 'package.json'), JSON.stringify({ version: sha[0] })); }
    if (args[0] === 'rev-parse') return { stdout: JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')).version.repeat(40) };
    if (fail && cmd === 'npm') throw new Error('PRIVATE_ERROR');
    return { stdout: '' };
  };
  const installer = new Installer({ directory, run });
  assert.equal((await installer.install()).current, sha);
  sha = 'b'.repeat(40); fail = true;
  await assert.rejects(installer.install(), (e) => e.code === 'INSTALL_FAILED' && !e.message.includes('PRIVATE_ERROR'));
  assert.equal((await installer.manifest()).current, 'a'.repeat(40));
  fail = false; await installer.install();
  assert.equal((await installer.manifest()).previous, 'a'.repeat(40));
  fail = true; await assert.rejects(installer.rollback()); assert.equal((await installer.manifest()).current, sha);
  fail = false; assert.equal((await installer.rollback()).current, 'a'.repeat(40));
  assert.ok(commands.some((c) => c.includes('--ignore-scripts')));
  assert.ok((await fs.readFile(path.join(directory, 'launch.mjs'), 'utf8')).includes('active.json'));
});
test('lifecycle CLI refuses unsafe report paths, malformed ports and unknown flags', () => {
  for (const [command, args] of [['report', ['--out', 'relative.json']], ['panel', ['--port', '65536']], ['login', ['--provider', 'unknown']], ['rollback', ['--force']], ['setup', ['extra']]]) assert.throws(() => parseLifecycle(command, args));
  assert.equal(parseLifecycle('login', []).provider, 'all'); assert.equal(parseLifecycle('panel', []).port, 0);
});

test('preserve-tasks is opt-in for upgrade and requires readable journals in both providers', () => {
  assert.equal(parseLifecycle('upgrade', ['--preserve-tasks'])['preserve-tasks'], true);
  assert.equal(parseLifecycle('upgrade', [])['preserve-tasks'], false);
  assert.throws(() => parseLifecycle('rollback', ['--preserve-tasks']));
  const report = { ok: true, providers: ['chatgpt', 'gemini'].map(provider => ({provider, checks:[{name:'task_journal',status:'warn',code:'TASK_ACTIVE'}]})) };
  assert.doesNotThrow(() => validateUpgradeReport(report));
  for (const bad of [null, {}, {ok:true,providers:[]}, {...report,ok:false}, {...report,providers:report.providers.slice(0,1)}]) {
    assert.throws(() => validateUpgradeReport(bad), {code:'INCOMPATIBLE_TASK_STATE'});
  }
  for (const code of ['INVALID_JOURNAL','IN_USE','UNREADABLE_LOCK','UNREADABLE_STATE']) {
    const changed = structuredClone(report);
    changed.providers[0].checks.push({name:'task_lock',status:'warn',code});
    assert.throws(() => validateUpgradeReport(changed), {code:'INCOMPATIBLE_TASK_STATE'});
  }
});

test('incompatible candidate diagnostics preserve the installed version', async t => {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'mcp-compatibility-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, {recursive:true,force:true}); });
  let revision='a', compatible=true, diagnostics=0;
  const run = async (cmd,args,cwd) => {
    if (cmd==='git' && args[0]==='clone') {
      await fs.mkdir(args.at(-1),{recursive:true});
      await fs.writeFile(path.join(args.at(-1),'package.json'),JSON.stringify({version:revision}));
    }
    if (args[0]==='rev-parse') return {stdout:JSON.parse(await fs.readFile(path.join(cwd,'package.json'),'utf8')).version.repeat(40)};
    if (cmd===process.execPath) {
      diagnostics++;
      return {stdout:JSON.stringify({ok:compatible,providers:['chatgpt','gemini'].map(provider=>({provider,checks:[{name:'task_journal',status:compatible?'warn':'fail',code:compatible?'TASK_ACTIVE':'INVALID_JOURNAL'}]}))})};
    }
    return {stdout:''};
  };
  const installer=new Installer({directory,run});
  await installer.install(); revision='b'; compatible=false;
  await assert.rejects(installer.install({preserveTasks:true}),{code:'INSTALL_FAILED'});
  assert.equal((await installer.manifest()).current,'a'.repeat(40));
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'last-failure.json'),'utf8')).stage,'task_compatibility');
  compatible=true;
  assert.equal((await installer.install({preserveTasks:true})).current,'b'.repeat(40));
  assert.equal(diagnostics,3);
  compatible=false;
  await assert.rejects(installer.rollback(), {code:'INCOMPATIBLE_TASK_STATE'});
  assert.equal((await installer.manifest()).current,'b'.repeat(40));
});

test('stable launcher retains upgrade command after rolling runtime back to an older release', async (t) => {
  const root = path.resolve(os.tmpdir()); const directory = await fs.mkdtemp(path.join(root, 'mcp-launcher-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  let revision = 'a';
  const run = async (cmd, args, cwd) => {
    if (cmd === process.execPath) return {stdout:JSON.stringify(readableReport())};
    if (cmd === 'git' && args[0] === 'clone') {
      cwd = args.at(-1); await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module', version: revision }));
      await fs.writeFile(path.join(cwd, 'src', 'cli.js'), `console.log('${revision}');`);
      if (revision === 'b') await fs.writeFile(path.join(cwd, 'src', 'lifecycle.js'), '');
    }
    return { stdout: args[0] === 'rev-parse' ? JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')).version.repeat(40) : '' };
  };
  const installer = new Installer({ directory, run });
  await installer.install(); revision = 'b'; await installer.install(); await installer.rollback();
  const exec = promisify(execFile); const launcher = path.join(directory, 'launch.mjs');
  assert.equal((await exec(process.execPath, [launcher, 'serve'])).stdout.trim(), 'a');
  assert.equal((await exec(process.execPath, [launcher, 'upgrade'])).stdout.trim(), 'b');
});
