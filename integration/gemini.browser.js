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

test('long attachment names use exact accessible descriptions and reject mismatches', async t => {
  const {b,page}=await fixture(t);
  b.config.actionTimeout=250;
  await page.evaluate(()=>{
    const d=document.createElement('div');d.id='full-file';d.hidden=true;d.textContent='完整的很长中文研究方案.md';document.body.append(d);
    const e=document.createElement('file-preview');e.innerHTML='<div aria-describedby="full-file"><span class="gem-attachment-text">完整的...方案</span></div>';document.body.append(e);
  });
  await b.waitForUploads([path.join(os.tmpdir(),'完整的很长中文研究方案.md')],{exact:true});
  await assert.rejects(b.waitForUploads([path.join(os.tmpdir(),'另一个研究方案.md')],{exact:true}));
  await page.evaluate(()=>{const e=document.createElement('file-preview');e.textContent='unexpected.txt';document.body.append(e);});
  await assert.rejects(b.waitForUploads([path.join(os.tmpdir(),'完整的很长中文研究方案.md')],{exact:true}));
});

test('explicit existing draft submission preserves attachments and sends once', async t => {
  const {b,page,directory}=await fixture(t);
  const kernel=new TaskKernel([geminiProvider(b)],{directory:path.join(directory,'tasks')});
  await b.writePrompt('recover\n\nthis draft');
  await page.evaluate(()=>{const e=document.createElement('file-preview');e.textContent='material.txt';document.body.append(e);});
  const file=path.join(directory,'material.txt');await fs.writeFile(file,'fixture material');
  const input={provider:'gemini',request_id:'recover-draft',prompt:'recover this draft',files:[file],existing_draft:true};
  assert.equal((await kernel.send({...input,request_id:'mismatch',prompt:'different'})).error.code,'DRAFT_MISMATCH');
  assert.equal(await page.evaluate(()=>window.sendCount),0);
  assert.equal((await kernel.send(input)).state,'submitted');
  assert.equal((await kernel.send(input)).replayed,true);
  assert.equal(await page.evaluate(()=>window.sendCount),1);
});

const fixtureHTML = `<!doctype html><html><body>
<style>user-query, model-response, message-content { display:block; }</style>
<a aria-label="Google Account">Account</a>
<a href="/app/older">Previous chat</a>
<main id="messages"></main>
<rich-textarea><div contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div></rich-textarea>
<button aria-label="Open mode picker" onclick="document.querySelector('#models').hidden=!document.querySelector('#models').hidden">Fast</button>
<div id="models" role="menu" hidden><button role="menuitem" data-mode-id="fixture-mode" onclick="document.querySelector('[aria-label=\\'Open mode picker\\']').textContent='Thinking';this.classList.add('selected');this.parentElement.hidden=true"><span class="label">Thinking</span><span class="sublabel">Advanced reasoning</span></button><button role="menuitem">Extended thinking</button></div>
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

for (const menu of [false, true]) {
test(`durable response retry uses ${menu ? 'Redo then Try again' : 'a direct retry button'} without adding a user turn`, async t => {
  const { b, page, directory } = await fixture(t);
  const kernel = new TaskKernel([geminiProvider(b)], { directory: path.join(directory, 'tasks') });
  const task = await kernel.send({ provider: 'gemini', request_id: 'retry-ui', prompt: 'Explain MPC' });
  await page.locator('[aria-label="Copy response"]').waitFor();
  await kernel.result(task.task_id);
  await page.evaluate(menu => {
    window.retryClicks = 0;
    const response=document.querySelector('model-response');
    const run=()=>{
      window.retryClicks++; document.querySelector('[role="menu"]')?.remove();
      const stop=document.createElement('button');stop.setAttribute('aria-label','Stop response');document.body.append(stop);
      setTimeout(()=>{response.querySelector('.markdown').textContent='Retried explanation';stop.remove();},500);
    };
    const retry=document.createElement('button');retry.setAttribute('aria-label',menu?'Redo':'Retry');
    retry.onclick=()=>{
      if(!menu)return run();
      const choices=document.createElement('div');choices.setAttribute('role','menu');
      for(const label of ['Longer','Shorter','Try again']){
        const option=document.createElement('button');option.setAttribute('role','menuitem');option.textContent=label;
        option.onclick=()=>{if(label!=='Try again')throw Error('Wrong retry action');run();};choices.append(option);
      }
      document.body.append(choices);
    };
    response.append(retry);
  },menu);
  assert.equal((await kernel.retry(task.task_id)).state, 'submitted');
  const result=await kernel.result(task.task_id,{wait:true,timeoutMs:10000});
  assert.equal(result.response.text,'Retried explanation');
  assert.equal((await kernel.retry(task.task_id)).replayed,true);
  assert.equal(await page.evaluate(()=>retryClicks),1);
  assert.equal(await page.evaluate(()=>sendCount),1);
  assert.equal(await page.locator('user-query').count(),1);
});
}

test('retry preserves a user draft and refuses a missing retry control without consuming its attempt', async t => {
  const { b, page, directory } = await fixture(t);
  const kernel=new TaskKernel([geminiProvider(b)],{directory:path.join(directory,'tasks')});
  const task=await kernel.send({provider:'gemini',request_id:'retry-preflight',prompt:'Question'});
  await page.locator('[aria-label="Copy response"]').waitFor();
  await kernel.result(task.task_id);
  await assert.rejects(kernel.retry(task.task_id),{code:'RETRY_UNAVAILABLE'});
  await b.writePrompt('Keep this draft');
  await assert.rejects(kernel.retry(task.task_id),{code:'DRAFT_PRESENT'});
  assert.equal((await kernel.result(task.task_id)).retry_count,undefined);
  assert.equal((await b.snapshot()).draft,'Keep this draft');
});

test('a model change after retry preflight prevents the generation click', async t => {
  const { b, page } = await fixture(t);
  await b.sendMessage({prompt:'Question',wait:false});
  await page.locator('[aria-label="Copy response"]').waitFor();
  await b.update({pending:null});
  await page.locator('model-response').evaluate(e=>{const button=document.createElement('button');button.setAttribute('aria-label','Redo');button.onclick=()=>{window.unexpectedRetry=true};e.append(button)});
  const click=await b.prepareRetry(await b.snapshot());
  await page.locator('[aria-label="Open mode picker"]').evaluate(e=>{e.textContent='Changed model'});
  await assert.rejects(click(),{code:'RETRY_TARGET_CHANGED'});
  assert.equal(await page.evaluate(()=>window.unexpectedRetry),undefined);
});

test('new named Gemini session waits for app mount and navigates only once', async (t) => {
  const { b, page } = await fixture(t);
  const context = page.context();
  let loads = 0;
  await context.route('https://gemini.google.com/app', route => {
    loads++;
    return route.fulfill({ contentType: 'text/html', body: fixtureHTML + `<script>const editor=document.querySelector('rich-textarea');editor.hidden=true;setTimeout(()=>{editor.hidden=false},400)</script>` });
  });
  const named = new GeminiBrowser(b.config, b.runtime, { sessionId: 'delayed-app' });
  const status = await named.runExclusive(() => named.status());
  assert.equal(status.signedIn, true); assert.equal(loads, 1);
  assert.equal((await named.state()).sessionInitialized, true);
  assert.equal(await (await named.page()).evaluate(() => sendCount), 0);
});

test('loading timeout is distinct from logout and resumed initialization preserves a draft', async (t) => {
  const { b, page } = await fixture(t);
  await page.locator('rich-textarea').evaluate(e => { e.hidden = true; });
  b.config.actionTimeout = 150;
  await assert.rejects(b.status(), e => e.code === 'PAGE_NOT_READY');
  await page.evaluate(() => { const a=document.createElement('a');a.textContent='Sign in';a.href='https://accounts.google.com/ServiceLogin';document.body.append(a); });
  assert.equal((await b.status()).signedIn, false);
  await page.locator('a[href*="ServiceLogin"]').evaluate(e => e.remove());
  await page.locator('rich-textarea').evaluate(e => { e.hidden = false; });
  const named = new GeminiBrowser(b.config, b.runtime, { sessionId: 'resume-app' });
  await named.status();
  await named.writePrompt('Keep this user draft');
  await named.update({ sessionInitialized: false });
  await named.close();
  assert.equal((await named.status()).draftPresent, true);
  assert.equal((await named.snapshot()).draft.trim(), 'Keep this user draft');
});

for (const message of ['Sorry, something went wrong. Please try your request again.', 'I encountered an error doing what you asked. Could you try again?', 'I seem to be encountering an error. Can I try something else for you?']) {
test(`provider service error is surfaced regardless of completion controls: ${message}`, async (t) => {
  const { b, page, directory } = await fixture(t);
  const kernel = new TaskKernel([geminiProvider(b)], { directory: path.join(directory, 'tasks') });
  const task = await kernel.send({ provider: 'gemini', request_id: 'service-error', prompt: 'test' });
  await page.locator('[aria-label="Copy response"]').waitFor();
  await page.locator('.markdown').evaluate((e, text) => { e.textContent = text; }, message);
  if (!message.startsWith('I seem')) await page.locator('[aria-label="Copy response"]').evaluate(e => e.remove());
  const result = await kernel.result(task.task_id, { wait: true, timeoutMs: 30000 });
  assert.equal(result.state, 'uncertain'); assert.equal(result.error.code, 'PAGE_ERROR');
  assert.equal(await page.evaluate(() => sendCount), 1);
  assert.equal((await kernel.abandon(task.task_id, { confirm: true })).state, 'abandoned');
});
}

test('Extended thinking is verified separately, idempotent, and fails closed on missing or ineffective controls', async (t) => {
  const { b, page } = await fixture(t);
  await page.getByRole('menuitem', { name: 'Extended thinking', includeHidden: true }).evaluate(e => {
    window.toggleCount = 0;
    e.onclick = () => { window.toggleCount++; e.classList.toggle('selected'); e.parentElement.hidden = true; };
  });
  const first = await b.selectModel('Thinking', { extended_thinking: true });
  assert.equal(first.extendedThinking, true); assert.equal(first.thinkingVerified, true);
  await b.selectModel('Thinking', { extended_thinking: true });
  assert.equal(await page.evaluate(() => toggleCount), 1);
  assert.equal((await b.setExtendedThinking(false)).extendedThinking, false);
  assert.equal(await page.evaluate(() => toggleCount), 2);
  await page.getByRole('menuitem', { name: 'Extended thinking', includeHidden: true }).evaluate(e => { e.onclick = () => {}; });
  await assert.rejects(b.setExtendedThinking(true), e => e.code === 'THINKING_NOT_CONFIRMED');
  await page.getByRole('menuitem', { name: 'Extended thinking', includeHidden: true }).evaluate(e => e.remove());
  b.config.actionTimeout = 200;
  await assert.rejects(b.setExtendedThinking(true), e => e.code === 'THINKING_UNAVAILABLE');
  assert.equal(await page.evaluate(() => sendCount), 0);
});

async function levelThinkingMenu(page) {
  await page.getByRole('menuitem', { name: 'Extended thinking', includeHidden: true }).evaluate(e => {
    const menu = e.parentElement;
    e.remove();
    window.levelClicks = 0;
    for (const level of ['Low', 'Medium', 'High']) {
      const row = document.createElement('button');
      row.setAttribute('role', 'menuitem');
      row.setAttribute('data-thinking-fixture', level);
      row.innerHTML = '<span class="label">' + level + '</span><span class="sublabel">Thinking detail</span>';
      if (level === 'Low') row.classList.add('selected');
      row.onclick = () => {
        window.levelClicks++;
        for (const sibling of menu.querySelectorAll('[data-thinking-fixture]')) sibling.classList.remove('selected');
        row.classList.add('selected');
        menu.hidden = true;
      };
      menu.append(row);
    }
  });
}

test('thinking levels select and reverify High, remain idempotent, and map false to Low', async t => {
  const { b, page } = await fixture(t);
  await levelThinkingMenu(page);
  await page.locator('main').evaluate(e => { e.innerHTML = '<button role="menuitem" class="selected">High</button>'; });
  const models = await b.listModels();
  assert.deepEqual(models.models.map(item => item.name), ['Thinking']);
  const result = await b.selectModel('Thinking', { extended_thinking: true });
  assert.equal(result.selectionVerified, true);
  assert.equal(result.thinkingLevel, 'High');
  assert.equal(result.extendedThinking, true);
  assert.equal(result.thinkingVerified, true);
  assert.equal((await b.setExtendedThinking(true)).thinkingLevel, 'High');
  assert.equal(await page.evaluate(() => levelClicks), 1);
  const low = await b.setExtendedThinking(false);
  assert.equal(low.thinkingLevel, 'Low'); assert.equal(low.extendedThinking, false);
  assert.equal(await page.evaluate(() => levelClicks), 2);
  assert.equal(await page.evaluate(() => sendCount), 0);
});

for (const failure of ['missing', 'disabled', 'ineffective', 'duplicate', 'multiple-selected']) {
  test('thinking levels fail closed when High is ' + failure, async t => {
    const { b, page } = await fixture(t);
    await levelThinkingMenu(page);
    await page.locator('[data-thinking-fixture="High"]').evaluate((e, failure) => {
      if (failure === 'missing') e.remove();
      if (failure === 'disabled') e.setAttribute('aria-disabled', 'true');
      if (failure === 'ineffective') e.onclick = () => {};
      if (failure === 'duplicate') e.after(e.cloneNode(true));
      if (failure === 'multiple-selected') e.classList.add('selected');
    }, failure);
    const code = failure === 'ineffective' ? 'THINKING_NOT_CONFIRMED' : ['duplicate', 'multiple-selected'].includes(failure) ? 'THINKING_AMBIGUOUS' : 'THINKING_UNAVAILABLE';
    await assert.rejects(b.setExtendedThinking(true), { code });
    assert.equal(await page.evaluate(() => sendCount), 0);
    assert.equal(await page.locator('[data-thinking-fixture="Low"]').getAttribute('class'), 'selected');
  });
}

async function staleEscapeMenu(page) {
  await page.evaluate(() => {
    const menu = document.querySelector('#models');
    const button = document.querySelector('[aria-label="Open mode picker"]');
    window.menuOpen = false; window.escapeCount = 0; window.toggleCount = 0;
    button.onclick = () => { window.menuOpen = !window.menuOpen; menu.hidden = !window.menuOpen; };
    // Reproduce the live popover: Escape hides the DOM but leaves the trigger
    // open, so the next trigger click closes it without displaying anything.
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { window.escapeCount++; menu.hidden = true; } });
    for (const item of menu.querySelectorAll('[role="menuitem"]')) item.onclick = () => {
      if (item.hasAttribute('data-mode-id')) { item.classList.add('selected'); button.textContent = 'Thinking'; }
      else { window.toggleCount++; item.classList.toggle('selected'); }
      menu.hidden = true; window.menuOpen = false;
    };
  });
}

test('model and thinking verification survive Escape-stale popovers without using Escape', async t => {
  const { b, page } = await fixture(t);
  await staleEscapeMenu(page);
  // A hidden stale option must not block readiness or enter the model list.
  await page.evaluate(() => { const old = document.createElement('button'); old.hidden = true; old.setAttribute('role', 'menuitem'); old.textContent = 'Old model'; document.body.prepend(old); });
  const models = await b.listModels();
  assert.deepEqual(models.models.map(m => m.name), ['Thinking']);
  assert.equal(await page.locator('#models').isVisible(), false);
  const result = await b.selectModel('Thinking', { extended_thinking: true });
  assert.equal(result.selectionVerified, true);
  assert.equal(result.extendedThinking, true); assert.equal(result.thinkingVerified, true);
  // Reconnect with the picker already open: do not blindly toggle it closed.
  await page.getByRole('button', { name: 'Open mode picker' }).click();
  const next = new GeminiBrowser(b.config, b.runtime);
  assert.equal((await next.setExtendedThinking(true)).thinkingVerified, true);
  assert.equal(await page.evaluate(() => toggleCount), 1);
  assert.equal(await page.evaluate(() => escapeCount), 0);
  assert.equal(await page.evaluate(() => menuOpen), false);
  assert.equal(await page.evaluate(() => sendCount), 0);
});

test('model menu recovers one stale trigger left by an earlier Escape', async t => {
  const { b, page } = await fixture(t);
  await staleEscapeMenu(page);
  await page.getByRole('button', { name: 'Open mode picker' }).click();
  await page.keyboard.press('Escape');
  b.config.actionTimeout = 250;
  assert.equal((await b.listModels()).models[0].name, 'Thinking');
  assert.equal(await page.evaluate(() => menuOpen), false);
  assert.equal(await page.evaluate(() => escapeCount), 1);
  assert.equal(await page.evaluate(() => sendCount), 0);
});

test('failure to open the picker is not reported as an unavailable thinking setting', async t => {
  const { b, page } = await fixture(t);
  await page.getByRole('button', { name: 'Open mode picker' }).evaluate(e => {
    window.pickerClicks = 0; e.onclick = () => { window.pickerClicks++; };
  });
  b.config.actionTimeout = 200;
  await assert.rejects(b.setExtendedThinking(true), { code: 'MODEL_MENU_NOT_OPEN' });
  assert.equal(await page.evaluate(() => pickerClicks), 2);
  assert.equal(await page.evaluate(() => sendCount), 0);
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
