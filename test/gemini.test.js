import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GeminiBrowser, conversationURL, isRateLimit } from "../src/gemini/browser.js";
import { geminiConfig } from "../src/gemini/config.js";
import { acquireLock, readState, writeState } from "../src/shared/persistent-browser.js";

async function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "gemini-unit-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), root);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const config = geminiConfig({ GEMINI_WEB_DATA_DIR: directory });
  const runtime = { disconnect: async () => {}, connect: async () => assert.fail("offline test must not open the browser") };
  return new GeminiBrowser(config, runtime);
}

test("Gemini config isolates provider state and enforces minimum intervals", () => {
  const config = geminiConfig({});
  assert.match(config.profile, /\.gemini-web-mcp/);
  assert.equal(config.sendInterval, 5000);
  assert.equal(config.changeInterval, 5000);
  assert.equal(config.recoveryInterval, 300000);
  assert.throws(() => geminiConfig({ GEMINI_WEB_SEND_INTERVAL_MS: "0" }), />= 5000/);
  assert.throws(() => geminiConfig({ GEMINI_WEB_RESPONSE_TIMEOUT_MS: "NaN" }), />= 1000/);
});

test("history URL validation rejects foreign hosts and non-conversation paths", () => {
  assert.equal(conversationURL("/app/abc123"), "https://gemini.google.com/app/abc123");
  for (const url of ["https://gemini.google.com.evil.test/app/a", "http://gemini.google.com/app/a", "https://example.com/app/a", "/settings", "/app/a?redirect=evil", "javascript:alert(1)"]) assert.throws(() => conversationURL(url), /Gemini conversation URL/);
});

test("rate limit classification supports English and Chinese", () => {
  for (const text of ["You've reached your usage limit", "Too many requests", "已达到今日使用上限"]) assert.equal(isRateLimit(text), true);
  assert.equal(isRateLimit("The response is ready"), false);
});

test("atomic state writes retain valid JSON and fail closed on corruption", async (t) => {
  const b = await fixture(t);
  await writeState(b.config.runtimeState, { pending: { startedAt: 123 } });
  assert.equal((await readState(b.config.runtimeState)).pending.startedAt, 123);
  await fs.writeFile(b.config.runtimeState, "corrupted");
  await assert.rejects(b.state(), SyntaxError);
});

test("operation lock excludes concurrent callers and respects cancellation", async (t) => {
  const b = await fixture(t);
  const release = await acquireLock(b.config.operationLock);
  const controller = new AbortController();
  const second = acquireLock(b.config.operationLock, { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, /abort/i);
  assert.equal((await readState(b.config.operationLock)).pid, process.pid);
  await release();
  await (await acquireLock(b.config.operationLock))();
});

test("a dead lock owner can be recovered but an incomplete live lock is not stolen", async (t) => {
  const b = await fixture(t);
  await fs.writeFile(b.config.operationLock, JSON.stringify({ pid: 2147483647, token: "dead" }));
  await (await acquireLock(b.config.operationLock))();
  await fs.writeFile(b.config.operationLock, "");
  await assert.rejects(acquireLock(b.config.operationLock, { timeout: 150 }), (e) => e.code === "BUSY");
});

test("runExclusive releases the lock on failure and serializes local callers", async (t) => {
  const b = await fixture(t);
  const order = [];
  await assert.rejects(b.runExclusive(async () => { throw new Error("failed"); }), /failed/);
  await Promise.all([b.runExclusive(async () => { order.push(1); }), b.runExclusive(async () => { order.push(2); })]);
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(await readState(b.config.operationLock), {});
});

test("pending sends block new sends and survive a new controller instance", async (t) => {
  const b = await fixture(t);
  await b.update({ pending: { startedAt: Date.now() } });
  const next = new GeminiBrowser(b.config, b.runtime);
  await assert.rejects(next.check(), (e) => e.code === "PENDING_RESPONSE");
  await assert.rejects(next.sendMessage({ prompt: "do not send" }), (e) => e.code === "PENDING_RESPONSE");
});

test("network circuit breaker persists, blocks writes, and needs confirmed recovery", async (t) => {
  const b = await fixture(t);
  b.networkLimited = true;
  await assert.rejects(b.check(), (e) => e.code === "RATE_LIMITED");
  assert.equal((await b.circuitBreakerStatus()).circuitBreaker.source, "HTTP_429");
  await assert.rejects(b.clearCircuitBreaker({ confirmed: false }), /confirmation/);
  const cleared = await b.clearCircuitBreaker({ confirmed: true });
  assert.equal(cleared.circuitBreaker, null);
  assert.ok(cleared.recoveryUntil >= Date.now() + 299000);
});

test("unconfirmed pending resolution and relative uploads fail without browser access", async (t) => {
  const b = await fixture(t);
  await assert.rejects(b.resolvePending({ confirmed: false }), (e) => e.code === "CONFIRMATION_REQUIRED");
  await assert.rejects(b.uploadFiles(["relative.txt"]), (e) => e.code === "INVALID_FILE");
});

test("provider local status never opens a browser", async (t) => {
  const b = await fixture(t);
  assert.equal((await b.browserLifecycle()).browserRunning, false);
  assert.equal((await b.circuitBreakerStatus()).pending, null);
});
