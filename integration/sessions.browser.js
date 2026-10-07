// Offline only: real Chromium targets, all HTTP fulfilled locally.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { geminiConfig } from '../src/gemini/config.js';
import { sessionPage, targetId } from '../src/shared/sessions.js';
import { ChatGPTBrowser } from '../src/browser.js';
let chrome;
before(async () => { chrome = await chromium.launch({ executablePath: geminiConfig().executable || chromium.executablePath(), headless: true }); });
after(async () => { await chrome?.close(); });
async function fixture(t) {
  const context = await chrome.newContext();
  await context.route('**/*', route => route.fulfill({ body: '<html><body><textarea></textarea></body></html>', contentType: 'text/html' }));
  t.after(() => context.close());
  let bindings = {};
  const bind = (sessionId, url = 'https://chatgpt.com/') => sessionPage(context, { sessionId, bindings, url, persist: async next => { bindings = next; } });
  return { context, bind, bindings: () => bindings };
}

for (const url of ['https://chatgpt.com/', 'https://gemini.google.com/app']) {
  test(`${url}: named tabs survive navigation and reconnect lookup, legacy draft is untouched`, async t => {
    const f = await fixture(t);
    const legacy = await f.context.newPage(); await legacy.goto(url); await legacy.locator('textarea').fill('user draft');
    const a = await f.bind('a', url), b = await f.bind('b', url);
    assert.notEqual(a, b); assert.notEqual(a, legacy);
    await a.locator('textarea').fill('answer A'); await b.locator('textarea').fill('answer B');
    await b.goto(new URL('/c/completed-b', url).href);
    // New calls rely only on persisted IDs, not a saved Page object or URL.
    assert.equal(await f.bind('a', url), a); assert.equal(await f.bind('b', url), b);
    assert.equal(await f.bind(undefined, url), legacy);
    assert.equal(await legacy.locator('textarea').inputValue(), 'user draft');
    assert.equal(await a.locator('textarea').inputValue(), 'answer A');
    assert.equal(f.bindings().a, await targetId(f.context, a));
  });
}

test('closed session never rebinds to another tab or creates a replacement', async t => {
  const f = await fixture(t); const a = await f.bind('a'), b = await f.bind('b'); await a.close();
  await assert.rejects(f.bind('a'), { code: 'SESSION_TAB_MISSING' });
  assert.equal(f.context.pages().length, 1); assert.equal(await f.bind('b'), b);
});

test('cross-origin navigation fails closed without affecting another session', async t => {
  const f = await fixture(t); const a = await f.bind('a'), b = await f.bind('b');
  await a.goto('https://unrelated.example/');
  await assert.rejects(f.bind('a'), { code: 'SESSION_NAVIGATED' });
  assert.equal(await f.bind('b'), b);
});

test('legacy calls cannot steal managed tabs; ambiguous unmanaged tabs are rejected', async t => {
  const f = await fixture(t); const a = await f.bind('a'), b = await f.bind('b');
  const legacy = await f.bind(); assert.notEqual(legacy, a); assert.notEqual(legacy, b);
  const extra = await f.context.newPage(); await extra.goto('https://chatgpt.com/');
  await assert.rejects(f.bind(), { code: 'AMBIGUOUS_TAB' });
  assert.equal(await f.bind('a'), a);
});

test('ChatGPT page operations retain the selected target even when another ChatGPT tab is first', async t => {
  const f = await fixture(t);
  const legacy = await f.context.newPage(); await legacy.goto('https://chatgpt.com/');
  await legacy.locator('textarea').fill('legacy draft');
  const a = await f.bind('a'), b = await f.bind('b');
  await a.locator('textarea').fill('session A draft');
  // Exercise the production page() method; the launch boundary supplies the
  // real target selected by sessionPage, without accessing a signed-in profile.
  const browser = new ChatGPTBrowser({ sessionId: 'b' });
  browser.launch = async () => b;
  const selected = await browser.page();
  assert.equal(selected, b);
  await selected.locator('textarea').fill('session B draft');
  assert.equal(await legacy.locator('textarea').inputValue(), 'legacy draft');
  assert.equal(await a.locator('textarea').inputValue(), 'session A draft');
  assert.equal(await b.locator('textarea').inputValue(), 'session B draft');
  await b.goto('https://unrelated.example/');
  await assert.rejects(browser.page(), { code: 'SESSION_NAVIGATED' });
  assert.equal(await a.locator('textarea').inputValue(), 'session A draft');
});
