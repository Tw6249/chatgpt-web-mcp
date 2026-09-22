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
import { TaskKernel } from "../src/core/tasks.js";
import { geminiProvider } from "../src/providers/adapters.js";

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
<div id="models" hidden><button role="menuitem" data-mode-id="fixture-mode" onclick="document.querySelector('[aria-label=\\'Open mode picker\\']').textContent='Thinking';this.classList.add('selected');this.parentElement.hidden=true"><span class="label">Thinking</span><span class="sublabel">Advanced reasoning</span></button><button role="menuitem">Extended thinking</button></div>
<input type="file" multiple onchange="for (const f of this.files) {const e=document.createElement('file-preview'); e.textContent=f.name; document.body.append(e)}">
<button aria-label="Send message" onclick="send()">Send</button>
<script>
window.sendCount=0;window.slow=false;
document.addEventListener('keydown', e=>{if(e.key==='Escape')document.querySelector('#models').hidden=true});
function send(){
 window.sendCount++;
 const input=document.querySelector('[contenteditable]');
 const query=document.createElement('user-query');const text=document.createElement('div');text.className='query-text';
 const announcement=document.createElement('h5');announcement.className='screen-reader-user-query-label';announcement.textContent='You said '+input.innerText.slice(0,12)+'…';text.append(announcement);
 for(const value of input.innerText.trim().split('\\n')){const line=document.createElement('p');line.className='query-text-line';line.textContent=' '+value+' ';text.append(line)}
 query.append(text);messages.append(query);input.innerText='';
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

test('unified tasks survive restart and reject legacy navigation until completion', async (t) => {
  const { b, page, directory } = await fixture(t);
  const kernel = new TaskKernel([geminiProvider(b)], { directory: path.join(directory, 'tasks') });
  const input = { provider: 'gemini', request_id: 'browser-restart', prompt: 'Unified\n  task' };
  const task = await kernel.send(input);
  assert.equal(task.state, 'submitted');
  const restarted = new TaskKernel([geminiProvider(new GeminiBrowser(b.config, b.runtime))], { directory: kernel.directory });
  await assert.rejects(restarted.run('gemini', () => b.newChat()), { code: 'TASK_ACTIVE' });
  assert.equal((await restarted.send(input)).task_id, task.task_id);
  const result = await restarted.result(task.task_id, { wait: true, timeoutMs: 10000 });
  assert.equal(result.state, 'completed'); assert.equal(result.response.text, 'Fixture reply 1');
  assert.equal(await page.evaluate(() => sendCount), 1); assert.equal((await b.state()).pending, null);
});

test('unified cancellation stops only the verified browser generation', async (t) => {
  const { b, page, directory } = await fixture(t);
  await page.evaluate(() => { window.slow = true; });
  const kernel = new TaskKernel([geminiProvider(b)], { directory: path.join(directory, 'tasks') });
  const task = await kernel.send({ provider: 'gemini', request_id: 'cancel', prompt: 'Cancellable' });
  await page.locator('[aria-label="Stop response"]').evaluate((e) => e.onclick = () => e.remove());
  const result = await kernel.read(task.task_id, { cancel: true });
  assert.equal(result.state, 'cancelled'); assert.equal(result.response.complete, false);
  assert.equal((await b.state()).pending, null); assert.equal(await page.evaluate(() => sendCount), 1);
});

test('model selection waits for a delayed new-page model picker', async (t) => {
  const { b, page } = await fixture(t);
  await page.locator('[aria-label="Open mode picker"]').evaluate((button) => { button.hidden = true; setTimeout(() => { button.hidden = false; }, 350); });
  const result = await b.runExclusive(() => b.selectModel('Thinking'));
  assert.equal(result.selectionVerified, true); assert.equal(await page.evaluate(() => sendCount), 0);
});

test('provider service error is not reported as a successful comparison answer', async (t) => {
  const { b, page, directory } = await fixture(t);
  const kernel = new TaskKernel([geminiProvider(b)], { directory: path.join(directory, 'tasks') });
  const task = await kernel.send({ provider: 'gemini', request_id: 'service-error', prompt: 'test' });
  await page.locator('[aria-label="Copy response"]').waitFor();
  await page.locator('.markdown').evaluate((e) => { e.textContent = 'Sorry, something went wrong. Please try your request again.'; });
  const result = await kernel.result(task.task_id);
  assert.equal(result.state, 'uncertain'); assert.equal(result.error.code, 'PAGE_ERROR');
  assert.equal(await page.evaluate(() => sendCount), 1);
  assert.equal((await kernel.abandon(task.task_id, { confirm: true })).state, 'abandoned');
});

test("browser sends once, waits for final text and can continue the conversation", async (t) => {
  const { b, page } = await fixture(t);
  const first = await b.runExclusive(() => b.sendMessage({ prompt: "Hello\n\n  indented line", timeoutMs: 10000 }));
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
    const button = document.createElement('button'); button.setAttribute('aria-label', 'Upload & tools'); button.textContent = 'Upload';
    button.onclick = () => {
      const item = document.createElement('button'); item.setAttribute('role', 'menuitem'); item.textContent = 'Upload files';
      item.onclick = () => {
        const input = document.createElement('input'); input.type = 'file'; input.hidden = true;
        input.onchange = () => {
          const preview = document.createElement('uploader-file-preview');
          const label = document.createElement('span'); label.className = 'gem-attachment-text'; label.textContent = input.files[0].name.replace(/\.txt$/, ''); preview.append(label); document.body.append(preview);
          const tooltip = document.createElement('div'); tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = input.files[0].name; document.body.append(tooltip);
        };
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
  const models = (await b.listModels()).models;
  assert.equal(models.length, 1, 'Settings entries must not be offered as models');
  assert.equal(models[0].name, "Thinking");
  assert.equal(models[0].description, "Advanced reasoning");
  assert.equal((await b.selectModel("Thinking")).model, "Thinking");
  assert.equal((await b.listHistory()).conversations[0].title, "Previous chat");
  await b.sendMessage({ prompt: "Archive this", timeoutMs: 6000 });
  const archive = await b.archiveConversation();
  assert.equal(archive.completeHistory, false);
  const text = await fs.readFile(archive.path, "utf8");
  assert.match(text, /Archive this/); assert.match(text, /Fixture reply/);
  assert.doesNotMatch(text, /You said/, 'Exclude duplicated screen-reader announcements');
});

test("past conversation attachments do not count as current composer uploads", async (t) => {
  const { b, page } = await fixture(t);
  await page.evaluate(() => {
    const old = document.createElement('user-query'); old.innerHTML = '<uploader-file-preview><span class="gem-attachment-text">past-file</span></uploader-file-preview>'; document.querySelector('#messages').append(old);
  });
  assert.equal((await b.snapshot()).attachments.length, 0);
  await b.writePrompt('New prompt without old attachment');
});

test("opening history waits for the asynchronous transcript, not just the composer", async (t) => {
  const { b, page } = await fixture(t);
  await page.route('**/app/past', (route) => route.fulfill({ contentType: 'text/html', body: fixtureHTML + `<script>setTimeout(()=>{const e=document.createElement('model-response');e.innerHTML='<message-content><div class="markdown">Loaded history answer</div></message-content><div class="response-footer complete">Finished</div>';document.querySelector('#messages').append(e)},800)</script>` }));
  await b.selectHistory('https://gemini.google.com/app/past');
  const answer = await b.getLatestResponse();
  assert.equal(answer.complete, true); assert.equal(answer.text, 'Loaded history answer');
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
