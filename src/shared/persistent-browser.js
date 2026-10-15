import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { controlRequest } from './control.js';
import { browserDiagnostics } from './browser-diagnostics.js';

export class WebUIError extends Error {
  constructor(code, message) { super(message); this.name = "WebUIError"; this.code = code; }
}

export async function readState(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export async function writeState(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export async function acquireLock(file, { signal, timeout = 20000 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeout;
  const token = randomUUID();
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return async () => {
        if ((await readState(file)).token === token) await fs.unlink(file);
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      // Never delete an empty lock: its owner may still be writing metadata.
      let owner;
      try { owner = await readState(file); } catch { owner = {}; }
      if (owner.pid && !processAlive(owner.pid)) {
        // Serialize stale-lock reclamation so two contenders cannot unlink a
        // newly acquired lock after both observing the same dead owner.
        let reclaim;
        try {
          reclaim = await fs.open(`${file}.reclaim`, "wx", 0o600);
          const current = await readState(file);
          if (current.pid && !processAlive(current.pid)) await fs.unlink(file);
        } catch (error) {
          if (!["EEXIST", "ENOENT"].includes(error.code)) throw error;
          await delay(100, undefined, { signal });
        } finally {
          if (reclaim) { await reclaim.close(); await fs.unlink(`${file}.reclaim`); }
        }
      } else await delay(100, undefined, { signal });
    }
  }
  throw new WebUIError("BUSY", "Another browser operation is running, or its lock needs manual inspection.");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function browserEndpoint(port, { signal, timeout = 1000, fetchImpl = fetch } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    signal?.throwIfAborted();
    const probeSignal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: signal ? AbortSignal.any([signal, probeSignal]) : probeSignal });
    if (!response.ok) return null;
    const value = await response.json();
    const url = new URL(value.webSocketDebuggerUrl);
    return url.protocol === 'ws:' && url.hostname === "127.0.0.1" && Number(url.port) === port ? url.href : null;
  } catch { signal?.throwIfAborted(); return null; }
}

// Provider-neutral persistent Chrome runtime. Connecting and disconnecting does
// not terminate Chrome; only explicit terminate() sends Browser.close.
export class PersistentBrowser {
  constructor(config, { connect = chromium.connectOverCDP.bind(chromium), fetchImpl = fetch, spawnImpl = spawn } = {}) {
    this.config = config; this.browser = null; this.context = null;
    this.connector = connect; this.fetchImpl = fetchImpl; this.spawnImpl = spawnImpl;
    this.diagnostic = browserDiagnostics(config.browserState);
    this.disconnecting = null; this.attaching = null; this.launched = false;
  }

  async connect(signal) {
    signal?.throwIfAborted();
    if (this.browser?.isConnected()) return this.context;
    if (this.attaching || this.disconnecting) throw new WebUIError('CONTROL_BUSY', 'The previous control connection is still closing; retry reading the same task later.');
    const config = this.config;
    this.launched = false;
    const prior = await readState(config.browserState);
    const probe = port => browserEndpoint(port, { signal, fetchImpl: this.fetchImpl });
    let target = prior.profile === config.profile && processAlive(prior.pid) ? await probe(prior.port) : null;
    if (!target) {
      if (prior.pid && processAlive(prior.pid)) throw new WebUIError("BROWSER_UNREACHABLE", "The dedicated browser is running but unreachable; inspect it before restarting.");
      if (prior.pid) void this.diagnostic('saved_process_missing', { pid: prior.pid });
      if (!config.executable) throw new WebUIError("NO_BROWSER", "Install Chrome/Edge or configure the provider browser executable.");
      await fs.mkdir(config.profile, { recursive: true });
      const port = await freePort();
      const args = [
        `--user-data-dir=${config.profile}`, "--profile-directory=Default",
        `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
        ...(config.launchArgs || []), ...(config.headless ? ["--headless=new"] : []), config.url,
      ];
      signal?.throwIfAborted();
      const child = this.spawnImpl(config.executable, args, { detached: true, stdio: "ignore", windowsHide: true });
      let launchError;
      child.on("error", (error) => { launchError = error; void this.diagnostic('process_error', { errorName: error.name }); });
      child.on('exit', (exitCode, exitSignal) => { void this.diagnostic('process_exit', { pid: child.pid, exitCode, signal: exitSignal }); });
      child.unref();
      this.launched = true;
      await writeState(config.browserState, { pid: child.pid, port, profile: config.profile, startedAt: Date.now() });
      void this.diagnostic('process_started', { pid: child.pid });
      const deadline = Date.now() + config.actionTimeout;
      while (Date.now() < deadline && !(target = await probe(port))) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new WebUIError("BROWSER_EXITED", "Browser exited; the dedicated profile may already be in use.");
        await delay(200, undefined, { signal });
      }
      if (!target) throw new WebUIError("BROWSER_TIMEOUT", "Timed out connecting to the dedicated browser.");
    }
    signal?.throwIfAborted();
    const started = Date.now();
    void this.diagnostic('connect_started');
    let accepted = true;
    const attempt = Promise.resolve().then(() => this.connector(target, { timeout: config.actionTimeout }));
    this.attaching = attempt;
    // Aborted/timed-out attaches may finish late. They must never become the
    // active controller or leak into the next operation.
    void attempt.then(async browser => {
      if (!accepted) await this.disconnectController(browser).catch(() => {});
    }, () => {}).finally(() => { if (this.attaching === attempt) this.attaching = null; });
    try {
      const browser = await controlRequest(attempt, { timeout: config.actionTimeout, signal, code: 'CONTROL_CONNECT_TIMEOUT', onInterrupt: () => { accepted = false; } });
      if (signal?.aborted) { accepted = false; await this.disconnectController(browser).catch(() => {}); signal.throwIfAborted(); }
      this.browser = browser;
      this.context = browser.contexts()[0];
      if (!this.context) { await this.disconnect(); throw new WebUIError("NO_CONTEXT", "The browser returned no default context."); }
      this.context.setDefaultTimeout(config.actionTimeout);
      const track = page => page.on('crash', () => { void this.diagnostic('page_crashed'); });
      this.context.pages().forEach(track);
      this.context.on('page', track);
      browser.on('disconnected', () => { void this.diagnostic('controller_disconnected', { expected: this.browser !== browser }); });
      void this.diagnostic('connect_ready', { durationMs: Date.now() - started });
      return this.context;
    } catch (error) {
      accepted = false;
      void this.diagnostic('connect_failed', { durationMs: Date.now() - started, errorName: error.name });
      throw error;
    }
  }

  async disconnect() {
    const browser = this.browser;
    this.browser = null; this.context = null;
    if (!browser) return this.disconnecting ? controlRequest(this.disconnecting, { timeout: 5000, code: 'CONTROL_DISCONNECT_TIMEOUT' }) : undefined;
    return this.disconnectController(browser);
  }

  async disconnectController(browser) {
    const closing = Promise.resolve().then(() => browser.close());
    this.disconnecting = closing;
    void closing.then(() => { if (this.disconnecting === closing) this.disconnecting = null; }, () => {
      // A failed close with a live controller poisons this runtime. Do not let
      // the next request overlap an unconfirmed controller cleanup.
      if (!browser.isConnected() && this.disconnecting === closing) this.disconnecting = null;
    });
    try { await controlRequest(closing, { timeout: 5000, code: 'CONTROL_DISCONNECT_TIMEOUT' }); }
    catch (error) { void this.diagnostic('disconnect_failed', { errorName: error.name }); throw error; }
  }

  async terminate() {
    // Never launch a browser just to close one.
    const state = await readState(this.config.browserState);
    if (!processAlive(state.pid)) return { closed: false, browserRunning: false };
    await this.connect();
    const session = await this.browser.newBrowserCDPSession();
    await session.send("Browser.close").catch((error) => {
      if (!/closed/i.test(error.message)) throw error;
    });
    await this.disconnect();
    const deadline = Date.now() + this.config.actionTimeout;
    while (processAlive(state.pid) && Date.now() < deadline) await delay(100);
    if (processAlive(state.pid)) throw new WebUIError("CLOSE_TIMEOUT", "Browser did not exit after the close request; its state was preserved.");
    await fs.unlink(this.config.browserState).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return { closed: true };
  }
}
