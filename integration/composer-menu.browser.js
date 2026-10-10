// Offline regression: no account, network, or persistent profile access.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { ChatGPTBrowser } from '../src/browser.js';
import { SELECTORS } from '../src/selectors.js';
import { geminiConfig } from '../src/gemini/config.js';
let browser;
before(async () => { browser = await chromium.launch({executablePath:geminiConfig().executable || chromium.executablePath(), headless:true}); });
after(async () => { await browser?.close(); });
async function fixture(t, control) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<aside><button aria-label="添加新项目" onclick="window.wrong=true">Project</button><button aria-label="Upload avatar" onclick="window.wrong=true">Avatar</button></aside><main>' + control + '</main>');
  return {page, reader:{page:async()=>page}};
}
for(const label of ['添加文件等内容','添加照片和文件','上传文件','Attach files','Upload files','Add photos & files','Add files and more']) {
  test('attachment selector ignores unrelated sidebar controls: '+label, async t => {
    const {page,reader} = await fixture(t, '<button aria-label="'+label+'" onclick="window.correct=true">Attach</button>');
    const target = await ChatGPTBrowser.prototype.firstVisible.call(reader,SELECTORS.attachmentButton,{timeout:100});
    assert.ok(target);
    assert.equal(await target.getAttribute('aria-label'),label);
    await target.click();
    assert.equal(await page.evaluate(()=>window.correct),true);
    assert.equal(await page.evaluate(()=>window.wrong),undefined);
  });
}
test('missing attachment button does not fall back to Add project', async t => {
  const {reader} = await fixture(t,'<textarea></textarea>');
  assert.equal(await ChatGPTBrowser.prototype.firstVisible.call(reader,SELECTORS.attachmentButton,{timeout:100}),null);
});
test('legacy composer testid remains supported', async t => {
  const {reader} = await fixture(t,'<button data-testid="composer-plus-btn">+</button>');
  const target = await ChatGPTBrowser.prototype.firstVisible.call(reader,SELECTORS.attachmentButton,{timeout:100});
  assert.equal(await target.getAttribute('data-testid'),'composer-plus-btn');
});
test('web search recognizes current menu rows and ignores old answer text', async t => {
  const {page} = await fixture(t, '<article>网页搜索</article><div id="prompt-textarea" contenteditable="true"></div><button aria-label="添加文件等内容" onclick="document.querySelector(\'#menu\').hidden=false">+</button><div id="menu" hidden><button data-list-navigation-item="true" onclick="document.querySelector(\'#prompt-textarea\').innerHTML=\'<span data-inline-selection-pill data-id=search>网页搜索</span>\';document.querySelector(\'#menu\').hidden=true"><div data-menu-row-content="true">网页搜索<span>查找实时新闻和信息</span></div></button></div>');
  const reader = Object.create(ChatGPTBrowser.prototype);
  reader.page = async()=>page;
  reader.ensureSignedIn = async()=>{};
  reader.pageInteraction = async()=>{};
  const result = await reader.enableWebSearch();
  assert.equal(result.selected,true);
  assert.equal(result.changed,true);
  assert.equal(await page.evaluate(()=>window.wrong),undefined);
  assert.equal((await reader.enableWebSearch()).changed,false);
});
