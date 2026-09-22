import { SELECTORS as chatgptSelectors } from '../selectors.js';
import { SELECTORS as geminiSelectors } from '../gemini/selectors.js';
import { WebUIError } from '../shared/persistent-browser.js';
import { CHROME_EXECUTABLE, BROWSER_STATE_FILE, RUNTIME_STATE_FILE, OPERATION_LOCK_FILE } from '../config.js';

async function stop(browser, selectors) {
  const button = await browser.firstVisible?.(selectors, { timeout: 500 }) || await browser.first?.(selectors);
  if (!button) throw new WebUIError('STOP_UNAVAILABLE', 'Generation stop control is unavailable; task remains reserved.');
  await button.click();
  await (await browser.page()).waitForFunction((selectors) => !selectors.some((s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')), selectors, { timeout: 20000 });
}

export function geminiProvider(browser) {
  return {
    id: 'gemini', browser,
    localConfig: browser.config,
    capabilities: { files: true, models: true, history: true, archive: 'loaded-messages', cancellation: true },
    isRoot: (url) => url === 'https://gemini.google.com/app',
    async prepare() {
      await browser.editable({ empty: true });
      const s = await browser.snapshot();
      return { url: s.url, userCount: s.userCount, responseCount: s.responseCount };
    },
    async send({ prompt, files }) {
      await browser.writePrompt(prompt);
      if (files.length) await browser.uploadFiles(files);
      return browser.submitPrompt({ wait: false });
    },
    async inspect() {
      const s = await browser.snapshot(); await browser.check(s, { allowPending: true });
      return { ...s, complete: !!s.text && !s.busy && s.completeControl };
    },
    async settle() { await browser.update({ pending: null, lastCompletedAt: Date.now() }); },
    cancel: () => stop(browser, geminiSelectors.stop),
  };
}

export function chatgptProvider(browser) {
  return {
    id: 'chatgpt', browser,
    localConfig: { executable: CHROME_EXECUTABLE, browserState: BROWSER_STATE_FILE, runtimeState: RUNTIME_STATE_FILE, operationLock: OPERATION_LOCK_FILE },
    capabilities: { files: true, models: true, history: true, archive: 'provider-transcript', cancellation: true },
    isRoot: (url) => url === 'https://chatgpt.com',
    isProvisional: (url) => /^\/c\/WEB:[^/]+$/.test(decodeURIComponent(new URL(url).pathname)),
    async prepare() {
      await browser.assertActionsAllowed('chat_send');
      await browser.ensureSignedIn();
      await browser.assertComposerEmpty('chat_send');
      await browser.ensureConversationCapacity({ allowRotate: false });
      await browser.refreshBeforeSend({ reason: 'unified-send' });
      const s = await browser.getLatestResponse({ includeTranscript: false });
      if (s.generating) throw new WebUIError('GENERATING', 'ChatGPT is still generating.');
      return { url: s.url, userCount: s.userMessageCount, responseCount: s.assistantMessageCount };
    },
    async send({ prompt, files }) {
      if (files.length) await browser.uploadFiles(files);
      await browser.writePrompt(prompt);
      return browser.submitPrompt({ wait: false, refresh: false });
    },
    async inspect() {
      const s = await browser.getLatestResponse({ includeTranscript: false });
      if (s.rateLimited || s.circuitBreaker?.active) throw new WebUIError('RATE_LIMITED', 'ChatGPT rate limit is active. No retry was sent.');
      return { url: s.url, userCount: s.userMessageCount, responseCount: s.assistantMessageCount, lastUser: s.lastUserMessage || '', text: s.response || '', busy: s.generating, complete: !!s.response && !s.generating, model: s.model };
    },
    settle: () => browser.settleManagedGeneration(),
    cancel: () => stop(browser, chatgptSelectors.stopButton),
  };
}
