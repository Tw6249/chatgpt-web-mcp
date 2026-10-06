// Offline DOM regressions. Launch a fresh ephemeral browser and block every
// request; never attach to the dedicated browser or read its runtime journal.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ChatGPTBrowser } from '../src/browser.js';
import { SELECTORS } from '../src/selectors.js';
import { geminiConfig } from '../src/gemini/config.js';
import { TaskKernel, textHash } from '../src/core/tasks.js';
import { chatgptProvider } from '../src/providers/adapters.js';

let chrome;
before(async () => {
  chrome = await chromium.launch({
    executablePath: geminiConfig().executable || chromium.executablePath(),
    headless: true,
  });
});
after(async () => { await chrome?.close(); });

const userSelector = SELECTORS.userMessages.join(', ');

for (const label of ['发送', 'Send', 'Send prompt']) {
  test(`send uses the visible ${label} button exactly once`, async t => {
    const { page } = await fixture(t, `<form><div contenteditable="true">Preserved draft</div><button type="submit" aria-label="${label}"></button></form>`);
    await page.evaluate(() => {
      window.submissions = 0; window.keypresses = 0;
      document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); window.submissions++; });
      document.addEventListener('keydown', () => window.keypresses++);
    });
    const sender = {
      firstVisible: async selectors => page.locator(selectors.join(', ')).first(),
      click: async target => target.click(),
    };
    await ChatGPTBrowser.prototype.clickSendButton.call(sender);
    assert.deepEqual(await page.evaluate(() => [window.submissions, window.keypresses]), [1, 0]);
  });
}

test('a missing or disabled send control preserves the draft without Enter fallback', async t => {
  const { page } = await fixture(t, '<div contenteditable="true">Preserved draft</div><button aria-label="发送" disabled></button>');
  for (const button of [null, page.locator('button')]) {
    await assert.rejects(ChatGPTBrowser.prototype.clickSendButton.call({
      firstVisible: async () => button,
      click: async () => assert.fail('must not click'),
    }), error => error.details.code === 'SEND_CONTROL_UNAVAILABLE');
  }
  assert.equal(await page.locator('[contenteditable]').innerText(), 'Preserved draft');
});
const assistantSelector = SELECTORS.assistantMessages.join(', ');
const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const html = (body) => `<!doctype html><html><body>
  <style>[data-search-result-target] { white-space: pre-wrap; }</style>
  ${body}</body></html>`;

function newUser(id, text, turn = 0, controls = true) {
  return `<div data-chatgpt-search-unit-key="fallback-turn-${turn}:0:user"
      data-chatgpt-search-message-ids="${id}">
    <div data-content-search-unit-key="fallback-turn-${turn}:0:user">
      <div data-user-message-bubble>
        <div data-search-result-target>${escapeHTML(text)}</div>
        ${controls ? '<span aria-hidden="true">…</span><button>显示更多</button>' : ''}
      </div>
    </div>
  </div>`;
}

function newAssistant(id, text, turn = 0, { chrome: controls = true, attributes = '' } = {}) {
  return `<div data-content-search-unit-key="fallback-turn-${turn}:0:assistant"
      data-chatgpt-search-unit-key="fallback-turn-${turn}:0:assistant"
      data-chatgpt-search-message-ids="${id} ${id}" ${attributes}>
    ${controls ? '<h4 data-conversation-role="assistant">ChatGPT 说：</h4>' : ''}
    <div data-chatgpt-selection-message-id="${id}">
      <div data-markdown-text-style="assistant-message">${escapeHTML(text)}</div>
    </div>
    ${controls ? '<button aria-label="Copy response">复制</button>' : ''}
  </div>`;
}

const reasoning = `<section data-turn="assistant-reasoning"
    data-chatgpt-search-unit-key="fallback-turn-0:0:reasoning">
  <h4 data-conversation-role="assistant">思考过程</h4>
  <div data-testid="thinking" class="loading-shimmer">Residual reasoning indicator</div>
</section>`;

async function fixture(t, body = '') {
  const context = await chrome.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('**/*', (route) => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(html(body));
  // Call the production DOM methods with only their page boundary mocked.
  const reader = { page: async () => page, userLocator: () => page.locator(userSelector) };
  return {
    page, reader,
    messages: () => ChatGPTBrowser.prototype.renderedConversationMessages.call(reader),
    streaming: () => ChatGPTBrowser.prototype.assistantIsStreaming.call(
      reader, page.locator(assistantSelector).last(),
    ),
  };
}

for (const tag of ['article', 'section', 'div']) {
  test(`legacy ${tag} messages preserve role, text and IDs`, async (t) => {
    const attribute = tag === 'div' ? 'data-message-author-role' : 'data-turn';
    const { page, messages } = await fixture(t, `
      <${tag} ${attribute}="user" data-message-id="u-old">Legacy prompt</${tag}>
      <${tag} ${attribute}="assistant" data-message-id="a-old">Legacy answer</${tag}>`);
    assert.equal(await page.locator(userSelector).count(), 1);
    assert.equal(await page.locator(assistantSelector).count(), 1);
    assert.deepEqual(await messages(), [
      { index: 0, author: 'user', id: 'u-old', text: 'Legacy prompt' },
      { index: 1, author: 'assistant', id: 'a-old', text: 'Legacy answer' },
    ]);
  });
}

test('semantic body nodes exclude headings and collapse controls from the exact prompt hash', async (t) => {
  const prompt = '请核验这个完整提示。\n\n  保留缩进与末尾内容 <tag> & "quoted"';
  const { page, reader, messages } = await fixture(t,
    newUser('u1', prompt) + reasoning + newAssistant('a1', '完整回答'),
  );
  assert.equal(await page.getByRole('button', { name: '显示更多' }).isVisible(), true);
  assert.equal(await page.locator(userSelector).count(), 1);
  assert.equal(await page.locator(assistantSelector).count(), 1);
  const actual = await messages();
  assert.deepEqual(actual, [
    { index: 0, author: 'user', id: 'u1', text: prompt },
    { index: 1, author: 'assistant', id: 'a1', text: '完整回答' },
  ]);
  assert.equal(textHash(actual[0].text), textHash(prompt));
  assert.notEqual(textHash(actual[0].text), textHash(`${prompt} … 显示更多`));
  assert.deepEqual(await ChatGPTBrowser.prototype.userMessageSnapshot.call(reader), {
    count: 1, lastText: prompt, lastId: 'u1',
  });
});

test('mixed nested legacy and semantic markup is counted once in document order', async (t) => {
  const { page, messages } = await fixture(t, `
    <section data-turn="user"><div data-message-author-role="user" data-message-id="u1">
      ${newUser('nested-u1', 'First prompt', 0, false)}
    </div></section>
    <article data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a1">
      ${newAssistant('nested-a1', 'First answer', 0, { chrome: false })}
    </div></article>
    ${reasoning}
    ${newUser('u2', 'Second prompt', 1)}
    ${newAssistant('a2', 'Second answer', 1)}
    <article data-turn="user" data-message-id="u3">
      ${newUser('nested-u3', 'Third prompt', 2, false)}
    </article>
    <section data-turn="assistant" data-message-id="a3">
      ${newAssistant('nested-a3', 'Third answer', 2, { chrome: false })}
    </section>`);
  assert.equal(await page.locator(userSelector).count(), 3);
  assert.equal(await page.locator(assistantSelector).count(), 3);
  const actual = await messages();
  assert.deepEqual(actual.map(({ index, author, id, text }) => ({ index, author, id, text: text.trim() })), [
    { index: 0, author: 'user', id: 'u1', text: 'First prompt' },
    { index: 1, author: 'assistant', id: 'a1', text: 'First answer' },
    { index: 2, author: 'user', id: 'u2', text: 'Second prompt' },
    { index: 3, author: 'assistant', id: 'a2', text: 'Second answer' },
    { index: 4, author: 'user', id: 'u3', text: 'Third prompt' },
    { index: 5, author: 'assistant', id: 'a3', text: 'Third answer' },
  ]);
});

test('semantic IDs prefer selection ID and split duplicate search IDs without reordering', async (t) => {
  const { page, messages } = await fixture(t,
    newUser('u1', 'One') + newAssistant('a1', 'First') +
    newUser('u2', 'Two', 1) + newAssistant('a2', 'Second', 1),
  );
  await page.locator('[data-chatgpt-search-unit-key$=":assistant"]').first()
    .evaluate((element) => element.setAttribute('data-chatgpt-search-message-ids', 'outer-id outer-id'));
  await page.locator('[data-chatgpt-selection-message-id="a2"]')
    .evaluate((element) => element.removeAttribute('data-chatgpt-selection-message-id'));
  assert.deepEqual((await messages()).map(({ index, author, id }) => [index, author, id]), [
    [0, 'user', 'u1'], [1, 'assistant', 'a1'], [2, 'user', 'u2'], [3, 'assistant', 'a2'],
  ]);
});

test('streaming on the answer leaf or its semantic ancestor blocks completion, reasoning does not', async (t) => {
  const { page, reader, streaming } = await fixture(t, reasoning + newAssistant('a1', 'Partial answer'));
  assert.equal(await ChatGPTBrowser.prototype.assistantIsStreaming.call(reader, null), false);
  assert.equal(await streaming(), false, 'a leftover reasoning shimmer is a sibling, not answer activity');
  const leaf = page.locator(assistantSelector);
  const ancestor = page.locator('[data-chatgpt-search-unit-key$=":assistant"]');
  for (const locator of [leaf, ancestor]) {
    await locator.evaluate((element) => element.setAttribute('data-is-streaming', 'true'));
    assert.equal(await streaming(), true);
    await locator.evaluate((element) => element.removeAttribute('data-is-streaming'));
    assert.equal(await streaming(), false);
  }
});

for (const [layout, body] of [
  ['legacy', '<div data-message-author-role="user" data-message-id="u1">Prompt</div>'],
  ['semantic user', newUser('u1', 'Prompt')],
  ['semantic assistant only', newAssistant('a1', 'Answer')],
]) {
  test(`${layout} transcript scroll methods use the message container rather than the document`, async (t) => {
    const { page, reader } = await fixture(t, `
      <style>html, body { margin: 0; overflow: hidden; }
        #transcript { height: 140px; overflow-y: auto; }</style>
      <div id="transcript">${body}<div style="height: 1600px">History spacer</div></div>`);
    await page.locator('#transcript').evaluate((element) => { element.scrollTop = 240; });
    const initial = await ChatGPTBrowser.prototype.transcriptScrollMetrics.call(reader);
    assert.equal(initial.available, true);
    assert.equal(initial.top, 240);
    assert.equal(initial.clientHeight, 140);
    assert.ok(initial.scrollHeight > initial.clientHeight);
    assert.equal(await ChatGPTBrowser.prototype.scrollTranscriptToTop.call(reader), true);
    assert.equal((await ChatGPTBrowser.prototype.transcriptScrollMetrics.call(reader)).top, 0);
    await ChatGPTBrowser.prototype.restoreTranscriptScroll.call(reader, initial.top);
    assert.equal((await ChatGPTBrowser.prototype.transcriptScrollMetrics.call(reader)).top, 240);
    await ChatGPTBrowser.prototype.restoreTranscriptScroll.call(reader, Number.MAX_SAFE_INTEGER);
    const clamped = await ChatGPTBrowser.prototype.transcriptScrollMetrics.call(reader);
    assert.equal(clamped.top, clamped.scrollHeight - clamped.clientHeight);
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0);
  });
}

test('editing a semantic user turn is detected without treating the ordinary composer as an edit', async (t) => {
  const { page, reader } = await fixture(t, `
    ${newUser('u1', 'Original prompt')}
    <form><textarea id="ordinary"></textarea></form>`);
  for (const selector of ['[data-user-message-bubble]', '[data-chatgpt-search-unit-key$=":user"]', '[data-content-search-unit-key$=":user"]']) {
    await page.locator(selector).evaluate((element) => {
      const editor = document.createElement('textarea'); editor.id = 'editing'; element.append(editor);
    });
    const state = await ChatGPTBrowser.prototype.composerEditState.call(reader, page.locator('#editing'));
    assert.equal(state.editing, true);
    assert.ok(state.reason);
    await page.locator('#editing').evaluate((element) => element.remove());
  }
  assert.deepEqual(await ChatGPTBrowser.prototype.composerEditState.call(reader, page.locator('#ordinary')), {
    editing: false, reason: null,
  });
});

async function taskFixture(t) {
  const f = await fixture(t);
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'chatgpt-message-tasks-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), root);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const url = 'https://chatgpt.com/c/offline-message-fixture';
  let sends = 0, settled = 0, draft = '';
  const noop = async () => {};
  const browser = {
    runExclusive: async (fn) => fn(),
    assertActionsAllowed: noop, ensureSignedIn: noop, assertComposerEmpty: noop,
    ensureConversationCapacity: noop, refreshBeforeSend: noop,
    writePrompt: async (prompt) => { draft = prompt; },
    submitPrompt: async () => { assert.ok(draft); sends++; return { url }; },
    settleManagedGeneration: async () => { settled++; },
    // Project real DOM extraction into the adapter's snapshot boundary. Calling
    // the full browser getter here would access the user's live runtime files.
    getLatestResponse: async () => {
      const messages = await f.messages();
      const users = messages.filter((message) => message.author === 'user');
      const assistants = messages.filter((message) => message.author === 'assistant');
      return {
        url, userMessageCount: users.length, assistantMessageCount: assistants.length,
        lastUserMessage: users.at(-1)?.text || '', response: assistants.at(-1)?.text || '',
        generating: !!await f.page.locator(SELECTORS.stopButton.join(', ')).count() || (assistants.length ? await f.streaming() : false),
        model: 'offline-fixture',
      };
    },
  };
  const provider = chatgptProvider(browser);
  const kernel = new TaskKernel([provider], { directory });
  const input = { provider: 'chatgpt', request_id: 'offline-one-send', prompt: '完整的独立测试提示\n包括最后一行' };
  return { ...f, kernel, provider, directory, input, sends: () => sends, settled: () => settled };
}

test('zero observations become uncertain; the original durable request recovers from semantic DOM without resending', async (t) => {
  const f = await taskFixture(t);
  const task = await f.kernel.send(f.input);
  assert.equal(task.state, 'submitted');
  assert.equal((await f.provider.inspect()).userCount, 0);
  // Deterministically expire only the fixture journal's 20-second UI grace.
  await f.kernel.locked('chatgpt', async (state, save) => {
    state.tasks[task.task_id].submitted_at = Date.now() - 30_000;
    await save();
  });
  const uncertain = await f.kernel.result(task.task_id);
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(uncertain.error.code, 'SEND_UNCONFIRMED');
  assert.equal(f.sends(), 1);
  assert.equal(f.settled(), 0);

  const restarted = new TaskKernel([f.provider], { directory: f.directory });
  const replay = await restarted.send(f.input);
  assert.equal(replay.task_id, task.task_id);
  assert.equal(replay.replayed, true);
  await f.page.setContent(html(newUser('u1', f.input.prompt) + reasoning + newAssistant('a1', 'Recovered answer')));
  const result = await restarted.result(task.task_id);
  assert.equal(result.task_id, task.task_id);
  assert.equal(result.state, 'completed');
  assert.equal(result.response.text, 'Recovered answer');
  assert.equal(f.settled(), 1);
  assert.equal(f.sends(), 1);
  assert.equal((await restarted.send(f.input)).task_id, task.task_id);
  assert.equal(f.sends(), 1);
});

test('wrong prompt cannot complete a durable task, and active semantic streaming stays running', async (t) => {
  const f = await taskFixture(t);
  const task = await f.kernel.send(f.input);
  await f.page.setContent(html(newUser('u1', 'Wrong prompt') + newAssistant('a1', 'Unrelated complete answer')));
  const wrong = await f.kernel.result(task.task_id);
  assert.equal(wrong.state, 'uncertain');
  assert.equal(wrong.error.code, 'SEND_UNCONFIRMED');
  assert.equal(wrong.response, null);
  assert.equal(f.settled(), 0);
  for (const marker of ['leaf', 'ancestor']) {
    await f.page.setContent(html(newUser('u1', f.input.prompt) + reasoning + newAssistant('a1', 'Still partial')));
    const selector = marker === 'leaf' ? assistantSelector : '[data-chatgpt-search-unit-key$=":assistant"]';
    await f.page.locator(selector).evaluate((element) => element.setAttribute('data-is-streaming', 'true'));
    const active = await f.kernel.result(task.task_id);
    assert.equal(active.state, 'running');
    assert.equal(active.response, null);
    assert.equal(f.settled(), 0);
  }
  await f.page.locator('[data-is-streaming]').evaluate((element) => element.removeAttribute('data-is-streaming'));
  const result = await f.kernel.result(task.task_id);
  assert.equal(result.state, 'completed');
  assert.equal(f.sends(), 1);
  assert.equal(f.settled(), 1);
});

test('plain Chinese stop control prevents an interim Pro reasoning summary from completing', async t => {
  const f = await taskFixture(t); const task = await f.kernel.send(f.input);
  await f.page.setContent(html(newUser('u1', f.input.prompt) + newAssistant('a1', '构造了反例') + '<button aria-label="停止"></button>'));
  const interim = await f.kernel.result(task.task_id);
  assert.equal(interim.state, 'running'); assert.equal(interim.response, null);
  await f.page.setContent(html(newUser('u1', f.input.prompt) + newAssistant('a1', 'Full research answer')));
  assert.equal((await f.kernel.result(task.task_id)).response.text, 'Full research answer');
  assert.equal(f.sends(), 1);
});

test('reasoning markdown without a semantic answer unit is not a response, even before stop mounts', async t => {
  const f = await taskFixture(t); const task = await f.kernel.send(f.input);
  await f.page.setContent(html(newUser('u1', f.input.prompt) + '<div><div data-markdown-text-style="assistant-message" data-markdown-text-tone="primary">Research commentary</div><div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">构造了反例</div></div>'));
  assert.equal((await f.provider.inspect()).responseCount, 0);
  const interim = await f.kernel.result(task.task_id);
  assert.equal(interim.state, 'submitted'); assert.equal(interim.response, null);
  await f.page.setContent(html(newUser('u1', f.input.prompt) + newAssistant('a1', 'Actual answer')));
  assert.equal((await f.kernel.result(task.task_id)).response.text, 'Actual answer');
});
