// Offline browser integration tests. Every Gemini request is intercepted with
// a deterministic local fixture; no account, live prompt or network is used.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { GeminiBrowser } from "../src/gemini/browser.js";
import { geminiConfig } from "../src/gemini/config.js";
import { PersistentBrowser, processAlive, readState } from "../src/shared/persistent-browser.js";

let chrome;
before(async () => { chrome = await chromium.launch({ executablePath: geminiConfig().executable || chromium.executablePath(), headless: true }); });
after(async () => { await chrome?.close(); });

const fixtureHTML = `<!doctype html><html><body>
<style>user-query, model-response, message-content { display:block; }</style>
<a aria-label="Google Account">Account</a>
<a href="/app/older">Previous chat</a>
<main id="messages"></main>
<rich-textarea><div contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div></rich-textarea>
<button aria-label="Open mode picker" onclick="document.querySelector('#models').hidden=false">Fast</button>
<div id="models" hidden><button role="menuitemradio" onclick="document.querySelector('[aria-label=\\'Open mode picker\\']').textContent='Thinking';this.parentElement.hidden=true">Thinking</button></div>
<input type="file" multiple onchange="for (const f of this.files) {const e=document.createElement('file-preview'); e.textContent=f.name; document.body.append(e)}">
<button aria-label="Send message" onclick="send()">Send</button>
<script>
window.sendCount=0;window.slow=false;
document.addEventListener('keydown', e=>{if(e.key==='Escape')document.querySelector('#models').hidden=true});
function send(){
 window.sendCount++;
 const input=document.querySelector('[contenteditable]');
 const query=document.createElement('user-query');const text=document.createElement('div');text.className='query-text';text.textContent=input.innerText.trim();query.append(text);messages.append(query);input.innerText='';
 document.querySelectorAll('file-preview').forEach(e=>e.remove());
 history.replaceState({},'', '/app/fixture');
 const response=document.createElement('model-response');response.innerHTML='<message-content><div class="markdown">Partial</div></message-content>';
 messages.append(response);const stop=document.createElement('button');stop.setAttribute('aria-label','Stop response');document.body.append(stop);
 if(window.slow)return;
 setTimeout(()=>{ response.querySelector('.markdown').textContent='Fixture reply '+window.sendCount;stop.remove();const copy=document.createElement('button');copy.setAttribute('aria-label','Copy response');copy.textContent='Copy';response.append(copy); },250);
}
</script></body></html>`;

async function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "gemini-browser-test-"));
  const context = await chrome.newContext();
  await context.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: fixtureHTML }));
  const page = await context.newPage();
  await page.goto("https://gemini.google.com/app");
  const config = geminiConfig({ GEMINI_WEB_DATA_DIR: directory });
  const b = new GeminiBrowser(config, { connect: async () => context, disconnect: async () => {} });
  t.after(async () => { await context.close(); assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  return { b, page, directory };
}

test("browser sends once, waits for final text and can continue the conversation", async (t) => {
  const { b, page } = await fixture(t);
  const first = await b.runExclusive(() => b.sendMessage({ prompt: "Hello", timeoutMs: 10000 }));
  assert.equal(first.complete, true); assert.equal(first.text, "Fixture reply 1");
  const second = await b.runExclusive(() => b.sendMessage({ prompt: "Follow up", timeoutMs: 10000 }));
  assert.equal(second.text, "Fixture reply 2"); assert.equal(await page.evaluate(() => sendCount), 2);
  assert.equal((await b.state()).pending, null);
});

test("draft and attachments survive refused new-chat and send operations", async (t) => {
  const { b, page, directory } = await fixture(t);
  await b.writePrompt("A user draft");
  await assert.rejects(b.writePrompt("Overwrite"), (e) => e.code === "DRAFT_PRESENT");
  await assert.rejects(b.newChat(), (e) => e.code === "DRAFT_PRESENT");
  assert.equal(await page.locator('[role="textbox"]').innerText(), "A user draft");
  await b.writePrompt(" + appended", { append: true });
  assert.equal(await page.locator('[role="textbox"]').innerText(), "A user draft + appended");
  const file = path.join(directory, "fixture.txt"); await fs.writeFile(file, "fixture");
  const result = await b.uploadFiles([file]); assert.equal(result.sent, false);
  await assert.rejects(b.sendMessage({ prompt: "Unexpected" }), (e) => e.code === "DRAFT_PRESENT");
  assert.equal(await page.evaluate(() => sendCount), 0);
});

test("timeout preserves intent; reconnect resumes without resending or switching chat", async (t) => {
  const { b, page } = await fixture(t);
  await page.evaluate(() => { window.slow = true; });
  const result = await b.sendMessage({ prompt: "Slow", timeoutMs: 1000 });
  assert.equal(result.timedOut, true); assert.equal(result.pending, true);
  const next = new GeminiBrowser(b.config, b.runtime);
  await assert.rejects(next.newChat(), (e) => e.code === "PENDING_RESPONSE");
  await assert.rejects(next.sendMessage({ prompt: "Duplicate" }), (e) => e.code === "PENDING_RESPONSE");
  await page.evaluate(() => { document.querySelector('[aria-label="Stop response"]').remove();document.querySelector('.markdown').textContent='Recovered';const e=document.createElement('button');e.textContent='Copy';e.setAttribute('aria-label','Copy response');document.querySelector('model-response').append(e); });
  const completed = await next.getLatestResponse({ wait: true, timeoutMs: 6000 });
  assert.equal(completed.text, "Recovered"); assert.equal(completed.complete, true);
  assert.equal(await page.evaluate(() => sendCount), 1);
});

test("upload menu waits for a file chooser and never sends the attachment", async (t) => {
  const { b, page, directory } = await fixture(t);
  await page.locator('input[type="file"]').evaluate((e) => e.remove());
  await page.evaluate(() => {
    const button = document.createElement('button'); button.setAttribute('aria-label', 'Upload files'); button.textContent = 'Upload';
    button.onclick = () => {
      const item = document.createElement('button'); item.setAttribute('role', 'menuitem'); item.textContent = 'Upload files';
      item.onclick = () => {
        const input = document.createElement('input'); input.type = 'file'; input.hidden = true;
        input.onchange = () => { const preview = document.createElement('file-preview'); preview.textContent = input.files[0].name; document.body.append(preview); };
        document.body.append(input); input.click();
      };
      document.body.append(item);
    };
    document.body.append(button);
  });
  const file = path.join(directory, 'menu-upload.txt'); await fs.writeFile(file, 'synthetic fixture');
  assert.deepEqual((await b.uploadFiles([file])).uploaded, ['menu-upload.txt']);
  assert.equal(await page.evaluate(() => sendCount), 0);
});

test("model listing, exact selection, visible history and scoped archive", async (t) => {
  const { b } = await fixture(t);
  assert.equal((await b.listModels()).models[0].name, "Thinking");
  assert.equal((await b.selectModel("Thinking")).model, "Thinking");
  assert.equal((await b.listHistory()).conversations[0].title, "Previous chat");
  await b.sendMessage({ prompt: "Archive this", timeoutMs: 6000 });
  const archive = await b.archiveConversation();
  assert.equal(archive.completeHistory, false);
  const text = await fs.readFile(archive.path, "utf8");
  assert.match(text, /Archive this/); assert.match(text, /Fixture reply/);
});

test("logged-out UI and page limit errors prevent a send", async (t) => {
  const { b, page } = await fixture(t);
  await page.evaluate(() => { const a=document.createElement('a');a.href='https://accounts.google.com/ServiceLogin';a.textContent='Sign in';document.body.append(a); });
  assert.equal((await b.status()).signedIn, false);
  await assert.rejects(b.sendMessage({ prompt: "Must not send" }), (e) => e.code === "LOGIN_REQUIRED");
  await page.locator('a[href*="ServiceLogin"]').evaluate((e) => e.remove());
  await page.evaluate(() => { const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent="You've reached your usage limit";document.body.append(alert); });
  await assert.rejects(b.sendMessage({ prompt: "Must not send" }), (e) => e.code === "RATE_LIMITED");
  assert.equal(await page.evaluate(() => sendCount), 0);
});

test("foreign navigation while waiting never returns another conversation's reply", async (t) => {
  const { b, page } = await fixture(t);
  await b.sendMessage({ prompt: "Once", wait: false });
  await b.getLatestResponse({ wait: true, timeoutMs: 1000 });
  await page.evaluate(() => history.replaceState({}, '', '/app/different'));
  await assert.rejects(b.getLatestResponse({ wait: true, timeoutMs: 1000 }), (e) => e.code === "CONVERSATION_CHANGED");
});

test("HTTP 429 is persisted and blocks subsequent writes without retrying", async (t) => {
  const { b, page } = await fixture(t);
  await b.page();
  let requests = 0;
  await page.route('**/fixture-rate-limit', (route) => { requests++; return route.fulfill({ status: 429, body: 'rate limited' }); });
  await page.evaluate(() => fetch('/fixture-rate-limit'));
  await assert.rejects(b.writePrompt("Blocked"), (e) => e.code === "RATE_LIMITED");
  assert.equal(requests, 1);
  assert.equal((await b.state()).circuitBreaker.active, true);
  assert.equal(await page.evaluate(() => sendCount), 0);
});

test("cancellation preserves an uncertain send and releases the operation lock", async (t) => {
  const { b, page } = await fixture(t);
  await page.evaluate(() => { window.slow = true; });
  const controller = new AbortController();
  const operation = b.runExclusive(() => b.sendMessage({ prompt: "Cancel waiting", timeoutMs: 10000 }), { signal: controller.signal });
  await page.locator('model-response').waitFor({ state: 'visible' });
  controller.abort();
  await assert.rejects(operation, /abort/i);
  assert.ok((await b.state()).pending);
  assert.deepEqual(await readState(b.config.operationLock), {});
  assert.equal(await page.evaluate(() => sendCount), 1);
});

test("last-minute draft changes are caught before clicking send", async (t) => {
  const { b, page } = await fixture(t);
  await b.writePrompt("Original");
  const originalThrottle = b.throttle.bind(b);
  b.throttle = async (kind) => { await originalThrottle(kind); await page.locator('[role="textbox"]').fill('Manually changed'); };
  await assert.rejects(b.submitPrompt(), (e) => e.code === "COMPOSER_CHANGED");
  assert.equal(await page.evaluate(() => sendCount), 0);
  assert.equal((await b.state()).pending, undefined);
});

test("dedicated browser persists across disconnects and explicit close terminates it", async (t) => {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "gemini-runtime-test-"));
  const config = { ...geminiConfig({ GEMINI_WEB_DATA_DIR: directory }), url: "about:blank", headless: true, executable: geminiConfig().executable || chromium.executablePath() };
  const runtime = new PersistentBrowser(config);
  t.after(async () => { await runtime.terminate(); assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await runtime.connect(); const first = await readState(config.browserState);
  await runtime.disconnect(); assert.equal(processAlive(first.pid), true);
  await runtime.connect(); assert.equal((await readState(config.browserState)).pid, first.pid);
  assert.equal((await runtime.terminate()).closed, true);
});
