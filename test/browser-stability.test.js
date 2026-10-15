import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { controlRequest } from '../src/shared/control.js';
import { PersistentBrowser, browserEndpoint, writeState, readState } from '../src/shared/persistent-browser.js';
import { browserDiagnostics } from '../src/shared/browser-diagnostics.js';
import { GeminiBrowser } from '../src/gemini/browser.js';
import { targetId } from '../src/shared/sessions.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-stability-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = { browserState: path.join(directory, 'browser-state.json'), profile: directory, actionTimeout: 60, operationLock: path.join(directory, 'operation.lock') };
  await writeState(config.browserState, { profile: directory, pid: process.pid, port: 12345 });
  return { directory, config };
}
const fetchImpl = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/browser/offline' }) });

test('control cancellation is bounded even when cleanup hangs; late results cannot resume the caller', async () => {
  let finish, resumed = 0, interrupted = 0;
  const controller = new AbortController();
  const read = controlRequest(new Promise(resolve => { finish = resolve; }), {
    signal: controller.signal,
    onInterrupt: () => { interrupted++; return new Promise(() => {}); },
  }).then(() => { resumed++; });
  controller.abort(new Error('cancelled read'));
  await assert.rejects(read, /cancelled read/);
  finish('late response');
  await new Promise(setImmediate);
  assert.equal(resumed, 0); assert.equal(interrupted, 1);
});

test('endpoint probes enforce a local deadline and reject a foreign debugging socket', async () => {
  const server = (await import('node:http')).createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await browserEndpoint(server.address().port, { timeout: 40 }), null); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(await browserEndpoint(12345, { fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://example.com:12345/private' }) }) }), null);
});

test('a stalled CDP attach times out without spawning another browser and disposes its late controller', async t => {
  const { config } = await fixture(t);
  let resolve, closes = 0, attempts = 0;
  const runtime = new PersistentBrowser(config, { fetchImpl, connect: () => { attempts++; return new Promise(done => { resolve = done; }); }, spawnImpl: () => assert.fail('must reuse live browser') });
  await assert.rejects(runtime.connect(), { code: 'CONTROL_CONNECT_TIMEOUT' });
  await assert.rejects(runtime.connect(), { code: 'CONTROL_BUSY' });
  const browser = new EventEmitter(); browser.close = async () => { closes++; };
  resolve(browser);
  await new Promise(setImmediate);
  assert.equal(runtime.browser, null); assert.equal(attempts, 1); assert.equal(closes, 1);
  assert.equal((await readState(config.browserState)).pid, process.pid);
});

test('aborting during attach does not publish a late context or kill the dedicated process', async t => {
  const { config } = await fixture(t);
  let resolve, closes = 0;
  const runtime = new PersistentBrowser(config, { fetchImpl, connect: () => new Promise(done => { resolve = done; }) });
  const signal = new AbortController();
  const attaching = runtime.connect(signal.signal);
  while (!resolve) await new Promise(setImmediate);
  signal.abort(); await assert.rejects(attaching, /abort/i);
  resolve({ close: async () => { closes++; } });
  await new Promise(setImmediate);
  assert.equal(closes, 1); assert.equal(runtime.context, null);
});

test('failed cleanup of a late controller blocks another attachment', async t => {
  const { config } = await fixture(t);
  let resolve, attempts = 0;
  const runtime = new PersistentBrowser(config, { fetchImpl, connect: () => {
    attempts++;
    return new Promise(done => { resolve = done; });
  } });
  await assert.rejects(runtime.connect(), { code: 'CONTROL_CONNECT_TIMEOUT' });
  resolve({ close: async () => { throw Error('disconnect rejected'); }, isConnected: () => true });
  await new Promise(setImmediate);
  await assert.rejects(runtime.connect(), { code: 'CONTROL_BUSY' });
  assert.equal(attempts, 1);
  assert.equal(runtime.browser, null);
});

test('live unreachable or mismatched profiles fail closed before launching', async t => {
  const { config } = await fixture(t);
  for (const profile of [config.profile, 'another-profile']) {
    await writeState(config.browserState, { profile, pid: process.pid, port: 12345 });
    const runtime = new PersistentBrowser(config, { fetchImpl: async () => { throw Error('offline'); }, spawnImpl: () => assert.fail('duplicate launch') });
    await assert.rejects(runtime.connect(), { code: 'BROWSER_UNREACHABLE' });
  }
});

test('cleanup failure still releases the Gemini operation lock', async t => {
  const { config } = await fixture(t);
  const browser = new GeminiBrowser(config, { disconnect: async () => { throw Error('controller cleanup failed'); } });
  await assert.rejects(browser.runExclusive(async () => 'observed'), /cleanup failed/);
  assert.deepEqual(await readState(config.operationLock), {});
});

test('stalled target identity reads are bounded and do not skip to a different tab', async () => {
  let detached = 0;
  const context = { newCDPSession: async () => ({ send: () => new Promise(() => {}), detach: async () => { detached++; } }) };
  await assert.rejects(targetId(context, {}, { timeout: 30 }), { code: 'CONTROL_TIMEOUT' });
  assert.equal(detached, 1);
});

test('diagnostic rotation retains only lifecycle metadata', async t => {
  const { config, directory } = await fixture(t);
  const file = path.join(directory, 'browser-diagnostics.jsonl');
  await fs.writeFile(file, ' '.repeat(512 * 1024 + 1));
  await browserDiagnostics(config.browserState)('page_crashed', { pid: 12, url: 'https://example.com/private', prompt: 'secret', message: 'private failure', targetId: 'conversation' });
  const entry = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(entry), ['at', 'event', 'pid']);
  assert.equal((await fs.stat(file + '.1')).size, 512 * 1024 + 1);
});
