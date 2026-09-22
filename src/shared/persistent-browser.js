import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

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

async function endpoint(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    const value = await response.json();
    const url = new URL(value.webSocketDebuggerUrl);
    return url.hostname === "127.0.0.1" && Number(url.port) === port ? url.href : null;
  } catch { return null; }
}

// Provider-neutral persistent Chrome runtime. Connecting and disconnecting does
// not terminate Chrome; only explicit terminate() sends Browser.close.
export class PersistentBrowser {
  constructor(config) { this.config = config; this.browser = null; this.context = null; }

  async connect(signal) {
    if (this.browser?.isConnected()) return this.context;
    const config = this.config;
    const prior = await readState(config.browserState);
    let target = prior.profile === config.profile && processAlive(prior.pid) ? await endpoint(prior.port) : null;
    if (!target) {
      if (prior.pid && processAlive(prior.pid)) throw new WebUIError("BROWSER_UNREACHABLE", "The dedicated browser is running but unreachable; inspect it before restarting.");
      if (!config.executable) throw new WebUIError("NO_BROWSER", "Install Chrome/Edge or set GEMINI_WEB_CHROME.");
      await fs.mkdir(config.profile, { recursive: true });
      const port = await freePort();
      const args = [
        `--user-data-dir=${config.profile}`, "--profile-directory=Default",
        `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
        ...(config.headless ? ["--headless=new"] : []), config.url,
      ];
      const child = spawn(config.executable, args, { detached: true, stdio: "ignore", windowsHide: true });
      let launchError;
      child.on("error", (error) => { launchError = error; });
      child.unref();
      await writeState(config.browserState, { pid: child.pid, port, profile: config.profile, startedAt: Date.now() });
      const deadline = Date.now() + config.actionTimeout;
      while (!(target = await endpoint(port)) && Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new WebUIError("BROWSER_EXITED", "Browser exited; the dedicated profile may already be in use.");
        await delay(200, undefined, { signal });
      }
      if (!target) throw new WebUIError("BROWSER_TIMEOUT", "Timed out connecting to the dedicated browser.");
    }
    signal?.throwIfAborted();
    this.browser = await chromium.connectOverCDP(target, { timeout: config.actionTimeout });
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new WebUIError("NO_CONTEXT", "The browser returned no default context.");
    this.context.setDefaultTimeout(config.actionTimeout);
    return this.context;
  }

  async disconnect() {
    await this.browser?.close().catch(() => {});
    this.browser = null; this.context = null;
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
