import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PersistentBrowser, WebUIError, acquireLock, readState, writeState, processAlive } from "../shared/persistent-browser.js";
import { geminiConfig } from "./config.js";
import { SELECTORS } from "./selectors.js";
import { sessionPage, sessionView, mergeSessionView, validateSessionId } from '../shared/sessions.js';
const SESSION_FIELDS = ['pending', 'selectedURL', 'sessionInitialized'];

// Gemini renders prompt lines with layout whitespace different from Quill's
// composer. Normalize only the acknowledgement hash; draft checks stay exact.
const hash = (value) => createHash("sha256").update(value.replace(/\s+/g, " ").trim()).digest("hex");
const normalize = (value) => value.replace(/\s+/g, " ").trim();

export function conversationURL(value) {
  const url = new URL(value, "https://gemini.google.com");
  if (url.origin !== "https://gemini.google.com" || !/^\/app(?:\/[a-zA-Z0-9_-]+)?\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new WebUIError("INVALID_URL", "Use a Gemini conversation URL on https://gemini.google.com/app/…");
  }
  return url.href.replace(/\/$/, "");
}

export function isRateLimit(text) {
  return /too many requests|you(?:'ve| have) reached (?:your|the).*limit|usage limit|rate limit|达到.{0,12}(?:上限|限额)|请求过于频繁|次数已用完|已达.{0,8}上限/i.test(text);
}

export function isResponseFailure(text = '') {
  return /^(?:Sorry, something went wrong\. Please try your request again\.|Something went wrong\. Please try again\.|I encountered an error doing what you asked\. Could you try again\?|I seem to be encountering an error\. Can I try something else for you\?|抱歉，出了点问题。请重试。)$/i.test(normalize(text));
}

export class GeminiBrowser {
  constructor(config = geminiConfig(), runtime = new PersistentBrowser(config), { sessionId } = {}) {
    this.sessionId = validateSessionId(sessionId);
    this.config = config; this.runtime = runtime; this.queue = Promise.resolve();
    this.currentPage = null; this.signal = undefined; this.networkLimited = false;
  }

  runExclusive(operation, { signal } = {}) {
    const execute = async () => {
      const release = await acquireLock(this.config.operationLock, { signal, timeout: this.config.actionTimeout });
      this.signal = signal;
      const onAbort = () => { void this.runtime.disconnect(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try { signal?.throwIfAborted(); return await operation(); }
      finally {
        signal?.removeEventListener("abort", onAbort);
        try { if (this.networkLimited) await this.markLimited("HTTP_429"); }
        finally { try { await this.close(); } finally { this.signal = undefined; await release(); } }
      }
    };
    const run = this.queue.then(execute, execute);
    this.queue = run.catch(() => {});
    return run;
  }

  async close() { await this.runtime.disconnect(); this.currentPage = null; }
  async state() { return sessionView(await readState(this.config.runtimeState), this.sessionId, SESSION_FIELDS); }
  async update(fields) {
    const raw = await readState(this.config.runtimeState);
    const value = { ...sessionView(raw, this.sessionId, SESSION_FIELDS), ...fields };
    await writeState(this.config.runtimeState, mergeSessionView(raw, value, this.sessionId, SESSION_FIELDS));
    return value;
  }

  async page() {
    this.signal?.throwIfAborted();
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    const context = await this.runtime.connect(this.signal);
    const state = await this.state();
    const page = await sessionPage(context, {
      sessionId: this.sessionId, bindings: state.sessionTabs, url: this.config.url,
      persist: (sessionTabs) => this.update({ sessionTabs }),
      beforeCreate: async () => {
        await this.check();
        if (context.pages().some((p) => p.url().startsWith('https://accounts.google.com/'))) throw new WebUIError('LOGIN_REQUIRED', 'Complete Google sign-in in the dedicated Gemini browser.');
        await this.throttle('change');
      },
    });
    this.currentPage = page;
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === "https://gemini.google.com" && response.status() === 429) this.networkLimited = true;
    });
    if (this.sessionId && !state.sessionInitialized) {
      // sessionPage already navigated a fresh tab. Wait for the app to mount;
      // navigating again can race initialization and must not clear a resumed draft.
      await this.waitForReady(page);
      await this.update({ sessionInitialized: true });
    }
    return page;
  }

  async first(selectors) {
    const page = await this.page();
    for (const selector of selectors) {
      for (const target of await page.locator(selector).all()) if (await target.isVisible()) return target;
    }
    return null;
  }

  async waitForReady(page) {
    try {
      await page.waitForFunction((selectors) => {
        const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
        const composer = selectors.some(s => [...document.querySelectorAll(s)].some(visible));
        const signIn = [...document.querySelectorAll('button, a')].some(e => visible(e) && /^(Sign in|登录)$/i.test(e.innerText.trim()));
        return composer || signIn;
      }, SELECTORS.composer, { timeout: this.config.actionTimeout });
    } catch (error) {
      this.signal?.throwIfAborted();
      if (error.name !== 'TimeoutError') throw error;
      throw new WebUIError('PAGE_NOT_READY', 'Gemini is still loading; no sign-in decision or send was made.');
    }
  }

  async snapshot() {
    const page = await this.page();
    const data = await page.evaluate((s) => {
      const visible = (e) => !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
      const first = (selectors) => selectors.flatMap((s) => [...document.querySelectorAll(s)]).find(visible);
      const users = [...document.querySelectorAll(s.user)].filter(visible);
      const responses = [...document.querySelectorAll(s.assistant)].filter(visible);
      const latest = responses.at(-1);
      const answer = latest?.querySelector(s.answer);
      const composer = first(s.composer);
      // Gemini includes a truncated screen-reader announcement inside
      // .query-text. Read the actual lines, not that duplicate announcement.
      const userLines = [...(users.at(-1)?.querySelectorAll('.query-text-line') || [])];
      return {
        url: location.href,
        signedIn: !!composer && !document.querySelector('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"]') && ![...document.querySelectorAll('button, a')].some((e) => visible(e) && /^(Sign in|登录)$/i.test(e.innerText.trim())),
        composerPresent: !!composer,
        draft: composer?.innerText || "",
        busy: !!first(s.stop),
        userCount: users.length, responseCount: responses.length,
        lastUser: userLines.length ? userLines.map((e) => e.innerText.trim()).join("\n") : (users.at(-1)?.querySelector('.query-text') || users.at(-1))?.innerText?.trim() || "",
        text: answer?.innerText?.trim() || "",
        completeControl: !!latest && [...latest.querySelectorAll(s.complete)].some(visible),
        alerts: [...document.querySelectorAll(s.alerts)].filter(visible).map((e) => e.innerText).join("\n"),
        attachments: [...document.querySelectorAll(s.attachments)].filter((e) => visible(e) && !e.closest('user-query, model-response') && !e.parentElement?.closest(s.attachments)).map((e) => e.innerText),
        model: first(s.model)?.innerText?.trim() || null,
      };
    }, SELECTORS);
    return data;
  }

  async status() {
    const page = await this.page();
    await this.waitForReady(page);
    const s = await this.snapshot();
    const state = await this.state();
    return { provider: "gemini", url: s.url, signedIn: s.signedIn, composerPresent: s.composerPresent, busy: s.busy, model: s.model, draftPresent: !!s.draft.trim(), attachmentCount: s.attachments.length, pending: state.pending || null, circuitBreaker: state.circuitBreaker || null };
  }

  async markLimited(source) {
    await this.update({ circuitBreaker: { active: true, source, at: Date.now() } });
    this.networkLimited = false;
  }

  async check(s = null, { allowPending = false } = {}) {
    this.signal?.throwIfAborted();
    const state = await this.state();
    if (this.networkLimited || (s && isRateLimit(s.alerts))) await this.markLimited(this.networkLimited ? "HTTP_429" : "page");
    if (this.networkLimited || state.circuitBreaker?.active || (await this.state()).circuitBreaker?.active) throw new WebUIError("RATE_LIMITED", "Gemini rate limit detected. No retry was sent. Wait and manually confirm recovery before clearing the circuit breaker.");
    if (state.pending && !allowPending) throw new WebUIError("PENDING_RESPONSE", "A previous send is pending or uncertain. Read its response before sending again or changing conversation.");
    if (s) {
      conversationURL(s.url);
      if (!s.signedIn) throw new WebUIError("LOGIN_REQUIRED", "Sign in to Gemini manually in its dedicated browser.");
      if (s.busy && !allowPending) throw new WebUIError("GENERATING", "Gemini is still generating a response.");
    }
  }

  async throttle(kind) {
    const state = await this.state();
    const until = Math.max((state.lastActionAt || 0) + this.config.changeInterval, state.recoveryUntil || 0,
      kind === "send" ? (state.lastSendAt || 0) + this.config.sendInterval : (state.lastCompletedAt || 0) + this.config.changeInterval);
    await delay(Math.max(0, until - Date.now()), undefined, { signal: this.signal });
    await this.update({ lastActionAt: Date.now() });
  }

  async editable({ empty = false } = {}) {
    await this.check();
    await this.waitForReady(await this.page());
    const s = await this.snapshot(); await this.check(s);
    if (empty && (s.draft.trim() || s.attachments.length)) throw new WebUIError("DRAFT_PRESENT", "The Gemini composer has a draft or attachments; preserve or send them first.");
    const composer = await this.first(SELECTORS.composer);
    if (!composer || await composer.evaluate((e) => !!e.closest('user-query, model-response'))) throw new WebUIError("NO_COMPOSER", "The main Gemini composer could not be identified safely.");
    return { composer, snapshot: s };
  }

  async newChat() {
    await this.editable({ empty: true }); await this.throttle("change");
    await this.editable({ empty: true });
    const page = await this.page();
    await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
    await this.waitForReady(page);
    await this.update({ selectedURL: this.config.url, lastActionAt: Date.now() });
    return this.status();
  }

  async writePrompt(prompt, { append = false } = {}) {
    if (!prompt.trim()) throw new WebUIError("EMPTY_PROMPT", "Prompt must not be blank.");
    const { composer, snapshot: s } = await this.editable();
    if (s.draft.trim() && !append && s.draft.trim() !== prompt.trim()) throw new WebUIError("DRAFT_PRESENT", "Refusing to overwrite an existing Gemini draft. Use append explicitly.");
    await composer.fill(append ? s.draft + prompt : prompt);
    const after = await this.snapshot();
    if (after.url !== s.url || normalize(after.draft) !== normalize(append ? s.draft + prompt : prompt)) throw new WebUIError("COMPOSER_CHANGED", "Gemini draft or conversation changed; nothing was sent.");
    return { written: true, sent: false };
  }

  async sendMessage({ prompt, wait = true, timeoutMs = this.config.responseTimeout }) {
    await this.editable({ empty: true });
    await this.writePrompt(prompt);
    return this.submitPrompt({ wait, timeoutMs });
  }

  async submitPrompt({ wait = true, timeoutMs = this.config.responseTimeout } = {}) {
    const { snapshot: before } = await this.editable();
    if (!before.draft.trim()) throw new WebUIError("EMPTY_PROMPT", "Write a prompt before submitting.");
    await this.throttle("send");
    const { snapshot: s } = await this.editable();
    if (s.url !== before.url || s.draft !== before.draft || JSON.stringify(s.attachments) !== JSON.stringify(before.attachments)) throw new WebUIError("COMPOSER_CHANGED", "The draft, attachments, or conversation changed before sending.");
    const send = await this.first(SELECTORS.send);
    if (!send || !await send.isEnabled()) throw new WebUIError("SEND_UNAVAILABLE", "Gemini send button is unavailable; wait for uploads to complete.");
    // Persist intent before clicking. Errors/cancellation must never cause a resend.
    await this.update({ pending: { originalURL: s.url, conversationURL: /\/app\/.+/.test(s.url) ? s.url : null, userCount: s.userCount, responseCount: s.responseCount, promptHash: hash(s.draft), startedAt: Date.now() }, lastSendAt: Date.now() });
    await send.click({ timeout: this.config.actionTimeout });
    return wait ? this.waitForResponse({ timeoutMs }) : { submitted: true, pending: true, url: (await this.page()).url() };
  }

  async prepareRetry(expected) {
    await this.editable({ empty: true }); await this.throttle('send');
    const page = await this.page();
    const checkIdentity = async () => {
      const s = await this.snapshot(); await this.check(s);
      if (s.url !== expected.url || s.userCount !== expected.userCount || s.responseCount !== expected.responseCount ||
          s.lastUser !== expected.lastUser || s.text !== expected.text || s.model !== expected.model || !s.completeControl || s.draft.trim() || s.attachments.length) {
        throw new WebUIError('RETRY_TARGET_CHANGED', 'The completed response or composer changed; nothing was retried.');
      }
    };
    await checkIdentity();
    const button = page.locator(SELECTORS.assistant).filter({ visible: true }).last().getByRole('button', { name: /^(Redo|Retry|Try again|重试|重新生成)$/i });
    if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) throw new WebUIError('RETRY_UNAVAILABLE', 'The last response has no available retry control.');
    return async () => {
      await checkIdentity();
      await this.update({ lastSendAt: Date.now() });
      await button.click();
      try {
        const waitForStart = (allowMenu) => page.waitForFunction(({ selectors, text, allowMenu }) => {
          const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
          if (selectors.stop.some(s => [...document.querySelectorAll(s)].some(visible))) return 'started';
          const latest = [...document.querySelectorAll(selectors.assistant)].filter(visible).at(-1);
          const next = latest?.querySelector(selectors.answer)?.innerText.trim();
          if (next && next !== text) return 'started';
          if (allowMenu && [...document.querySelectorAll('[role="menuitem"]')].some(e => visible(e) && /^(Try again|重试)$/i.test(e.innerText.trim()))) return 'menu';
          return false;
        }, { selectors: SELECTORS, text: expected.text, allowMenu }, { timeout: this.config.actionTimeout });
        const ready = await waitForStart(true);
        const kind = await ready.jsonValue(); await ready.dispose();
        if (kind === 'menu') {
          // Current Gemini opens a menu with Longer, Shorter and Try again.
          // Only the unchanged-answer retry is authorized here.
          await checkIdentity();
          await page.getByRole('menuitem', { name: /^(Try again|重试)$/i }).click();
          await (await waitForStart(false)).dispose();
        }
      } catch (error) {
        this.signal?.throwIfAborted();
        if (error.name !== 'TimeoutError') throw error;
        throw new WebUIError('RETRY_UNCONFIRMED', 'The retry click was issued but a new generation was not confirmed. Inspect the original page; do not click again.');
      }
      return { started: true };
    };
  }

  async waitForResponse({ timeoutMs = this.config.responseTimeout } = {}) {
    const deadline = Date.now() + timeoutMs;
    let previous = "", stableSince = Date.now();
    while (Date.now() < deadline) {
      const s = await this.snapshot(); await this.check(s, { allowPending: true });
      const pending = (await this.state()).pending;
      if (!pending) return this.getLatestResponse();
      if (pending.conversationURL && s.url !== pending.conversationURL) throw new WebUIError("CONVERSATION_CHANGED", "Gemini conversation changed while waiting; pending send was preserved.");
      const acknowledged = s.userCount > pending.userCount && hash(s.lastUser) === pending.promptHash;
      if (acknowledged && !s.busy && isResponseFailure(s.text)) throw new WebUIError('PAGE_ERROR', 'Gemini returned a service error instead of an answer. Inspect the page; do not automatically resend.');
      if (acknowledged && !pending.conversationURL && /\/app\/.+/.test(s.url)) await this.update({ pending: { ...pending, conversationURL: s.url }, selectedURL: s.url });
      const signature = JSON.stringify([s.text, s.busy, s.completeControl, s.userCount, s.responseCount]);
      if (signature !== previous) { previous = signature; stableSince = Date.now(); }
      if (acknowledged && s.responseCount > pending.responseCount && s.text && !s.busy && s.completeControl && Date.now() - stableSince >= 2000) {
        await this.update({ pending: null, lastCompletedAt: Date.now(), selectedURL: s.url });
        return { provider: "gemini", url: s.url, text: s.text, complete: true, pending: false, model: s.model };
      }
      if (s.alerts && !isRateLimit(s.alerts)) throw new WebUIError("PAGE_ERROR", "Gemini displays an error. Inspect the page; the send remains pending to prevent duplicates.");
      // Wake on DOM mutation; bounded idle timeout also confirms stable completion.
      const page = await this.page();
      await page.evaluate(() => new Promise((resolve) => {
        let timer; const finish = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
        const observer = new MutationObserver(finish); observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        timer = setTimeout(finish, 1000);
      }));
    }
    const s = await this.snapshot();
    const pending = (await this.state()).pending;
    return { provider: "gemini", url: s.url, text: pending && s.responseCount <= pending.responseCount ? "" : s.text, complete: false, pending: true, timedOut: true, nextAction: "Call gemini_get_latest_response with wait=true. Do not resend." };
  }

  async getLatestResponse({ wait = false, timeoutMs = this.config.responseTimeout } = {}) {
    if (wait && (await this.state()).pending) return this.waitForResponse({ timeoutMs });
    const s = await this.snapshot();
    const pending = (await this.state()).pending;
    if (pending?.conversationURL && pending.conversationURL !== s.url) throw new WebUIError("CONVERSATION_CHANGED", "Gemini conversation changed; the pending send was preserved.");
    if (!s.busy && isResponseFailure(s.text)) throw new WebUIError('PAGE_ERROR', 'Gemini returned a service error instead of an answer.');
    return { provider: "gemini", url: s.url, text: pending && s.responseCount <= pending.responseCount ? "" : s.text, complete: !!s.text && !s.busy && s.completeControl && !pending, pending: !!pending, model: s.model };
  }

  async resolvePending({ confirmed }) {
    if (confirmed !== true) throw new WebUIError("CONFIRMATION_REQUIRED", "Manually inspect the page and confirm the previous send is resolved.");
    const s = await this.snapshot();
    if (s.busy) throw new WebUIError("GENERATING", "Gemini is still generating.");
    await this.update({ pending: null });
    return { resolved: true, resent: false };
  }

  async circuitBreakerStatus() { const s = await this.state(); return { circuitBreaker: s.circuitBreaker || null, pending: s.pending || null, recoveryUntil: s.recoveryUntil || null }; }
  async clearCircuitBreaker({ confirmed }) {
    if (confirmed !== true) throw new WebUIError("CONFIRMATION_REQUIRED", "Manual confirmation of rate-limit recovery is required.");
    await this.update({ circuitBreaker: null, recoveryUntil: Date.now() + this.config.recoveryInterval });
    return this.circuitBreakerStatus();
  }

  async browserLifecycle() {
    const state = await readState(this.config.browserState);
    return { provider: "gemini", persistent: true, browserRunning: processAlive(state.pid), profile: this.config.profile, ...await this.circuitBreakerStatus() };
  }

  async listModels() {
    await this.editable(); await this.throttle("change");
    const menu = await this.openModelMenu();
    try {
      return { models: (await this.modelOptions(menu)).map(({ target, ...value }) => value) };
    } finally { await this.closeModelMenu(); }
  }

  async visibleModelMenu() {
    const page = await this.page();
    return page.locator(`:is(${SELECTORS.modelMenu}):visible`).filter({ has: page.locator(SELECTORS.models) });
  }

  async openModelMenu() {
    const menu = await this.visibleModelMenu();
    // Escape can hide Gemini's popover without resetting its trigger state.
    // In that case the first click only resets the trigger; permit one recovery
    // click, and distinguish failure to open from an unavailable setting.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await menu.count() === 1) return menu;
      if (await menu.count() > 1) throw new WebUIError('MODEL_MENU_AMBIGUOUS', 'Multiple model-menu candidates are visible; nothing was selected.');
      if (attempt) await this.throttle('change');
      await (await this.modelButton()).click();
      try {
        await menu.waitFor({ state: 'visible', timeout: this.config.actionTimeout });
        return menu;
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
      }
    }
    throw new WebUIError('MODEL_MENU_NOT_OPEN', 'Gemini model menu did not open after one recovery click; model and thinking availability could not be checked.');
  }

  async closeModelMenu() {
    const menu = await this.visibleModelMenu();
    if (!await menu.count()) return;
    // Use the same trigger to close it, rather than Escape, and wait for the
    // actual menu state before the next selection/verification operation.
    await (await this.modelButton()).click();
    try { await menu.waitFor({ state: 'hidden', timeout: this.config.actionTimeout }); }
    catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw new WebUIError('MODEL_MENU_NOT_CLOSED', 'Gemini model menu did not close; stop before another settings operation.');
    }
  }

  async modelOptions(menu) {
    menu ??= await this.visibleModelMenu();
    const items = [];
    for (const target of await menu.locator(SELECTORS.models).all()) {
      if (!await target.isVisible()) continue;
      items.push({ target, ...await target.evaluate((e) => ({
        mode: e.hasAttribute('data-mode-id'),
        name: (e.querySelector('.label') || e).innerText.trim(),
        description: e.querySelector('.sublabel')?.innerText.trim() || null,
        selected: e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true' || e.classList.contains('selected'),
        disabled: e.getAttribute('aria-disabled') === 'true' || e.disabled === true,
      })) });
    }
    // Current menus also contain an "Extended thinking" settings entry.
    // Only actual mode rows have data-mode-id; do not treat settings as models.
    return (items.some((item) => item.mode) ? items.filter((item) => item.mode) : items).map(({ mode, ...item }) => item);
  }

  async setExtendedThinking(enabled) {
    if (typeof enabled !== 'boolean') throw new WebUIError('INVALID_ARGUMENT', 'extended_thinking must be boolean.');
    const inspect = async (change) => {
      await this.editable(); await this.throttle('change');
      const menu = await this.openModelMenu();
      try {
        // Newer menus replace the binary switch with Low / Medium / High
        // settings rows. Keep the boolean API: true requests High, false Low.
        // Only inspect settings inside this menu, never model names or page text.
        const levels = [];
        for (const target of await menu.locator(SELECTORS.models).all()) {
          if (!await target.isVisible()) continue;
          const detail = await target.evaluate(e => ({
            mode: e.hasAttribute('data-mode-id'),
            name: (e.querySelector('.label') || e).innerText.trim(),
            selected: e.classList.contains('selected') || e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true',
            disabled: e.getAttribute('aria-disabled') === 'true' || e.disabled === true,
          }));
          if (!detail.mode && /^(Low|Medium|High)$/i.test(detail.name)) levels.push({ target, ...detail });
        }
        if (levels.length) {
          const wanted = enabled ? 'High' : 'Low';
          const matches = levels.filter(item => item.name.toLowerCase() === wanted.toLowerCase());
          if (matches.length > 1 || levels.filter(item => item.selected).length > 1) throw new WebUIError('THINKING_AMBIGUOUS', 'Gemini thinking levels are ambiguous; nothing was selected.');
          if (matches.length !== 1 || matches[0].disabled || !await matches[0].target.isEnabled()) throw new WebUIError('THINKING_UNAVAILABLE', `Gemini thinking level ${wanted} is unavailable; no lower level was substituted.`);
          if (change && !matches[0].selected) { await matches[0].target.click(); return null; }
          return { selected: matches[0].selected ? enabled : !enabled, thinkingLevel: levels.find(item => item.selected)?.name || null };
        }
        const item = menu.getByRole('menuitem', { name: /Extended thinking/i });
        try { await item.waitFor({ state: 'visible', timeout: this.config.actionTimeout }); }
        catch (error) { if (error.name !== 'TimeoutError') throw error; }
        if (await item.count() !== 1 || !await item.isVisible() || !await item.isEnabled()) throw new WebUIError('THINKING_UNAVAILABLE', 'Extended thinking is unavailable in the current Gemini model menu.');
        const selected = await item.evaluate(e => e.classList.contains('selected') || e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true');
        if (change && selected !== enabled) { await item.click(); return null; }
        return { selected, thinkingLevel: selected ? 'Extended thinking' : 'Standard' };
      } finally { await this.closeModelMenu(); }
    };
    let result = await inspect(true);
    if (result === null) result = await inspect(false);
    if (result.selected !== enabled) throw new WebUIError('THINKING_NOT_CONFIRMED', 'Gemini did not confirm the requested thinking setting.');
    return { extendedThinking: result.selected, thinkingLevel: result.thinkingLevel, thinkingVerified: true };
  }

  async selectModel(model, { extended_thinking } = {}) {
    await this.editable(); await this.throttle("change");
    const menu = await this.openModelMenu();
    try {
      const matches = (await this.modelOptions(menu)).filter((item) => normalize(item.name) === normalize(model));
      if (matches.length !== 1 || matches[0].disabled || !await matches[0].target.isEnabled()) throw new WebUIError("MODEL_UNAVAILABLE", "Use one exact available name returned by gemini_list_models.");
      await matches[0].target.click();
    } finally { await this.closeModelMenu(); }
    const checked = await this.listModels();
    if (!checked.models.some((item) => normalize(item.name) === normalize(model) && item.selected)) throw new WebUIError("MODEL_NOT_CONFIRMED", "The model selection could not be confirmed from Gemini's menu.");
    const thinking = extended_thinking === undefined ? {} : await this.setExtendedThinking(extended_thinking);
    return { ...await this.status(), selectedModel: model, selectionVerified: true, ...thinking };
  }

  async modelButton() {
    const page = await this.page();
    try {
      await page.waitForFunction((selectors) => selectors.some((selector) => [...document.querySelectorAll(selector)].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled)), SELECTORS.model, { timeout: this.config.actionTimeout });
    } catch { throw new WebUIError('NO_MODEL_MENU', 'Gemini model picker did not become ready; nothing was sent.'); }
    const button = await this.first(SELECTORS.model);
    if (!button) throw new WebUIError('NO_MODEL_MENU', 'Gemini model picker is unavailable.');
    return button;
  }

  async listHistory({ query = "", limit = 20 } = {}) {
    const page = await this.page(); const s = await this.snapshot(); await this.check(s, { allowPending: true });
    const links = await page.locator('a[href^="/app/"]').evaluateAll((items) => items.filter((e) => e.getClientRects().length).map((e) => ({ title: e.innerText.trim(), url: e.href })));
    return { scope: "currently loaded sidebar", conversations: [...new Map(links.map((v) => [v.url, v])).values()].filter((v) => v.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit) };
  }

  async selectHistory(url) {
    const target = conversationURL(url);
    if (!/\/app\/.+/.test(target)) throw new WebUIError("INVALID_URL", "Specify an existing Gemini conversation URL.");
    await this.editable({ empty: true }); await this.throttle("change"); await this.editable({ empty: true });
    const page = await this.page();
    await page.goto(target, { waitUntil: "domcontentloaded" });
    // The composer mounts before history arrives. Do not report a selected
    // conversation as ready while its last answer is still absent.
    await page.waitForFunction((s) => {
      const visible = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      if (s.stop.some((selector) => [...document.querySelectorAll(selector)].some(visible))) return true;
      const last = [...document.querySelectorAll(s.assistant)].at(-1);
      return !!last?.querySelector(s.answer)?.innerText.trim() && [...last.querySelectorAll(s.complete)].some(visible);
    }, SELECTORS, { timeout: this.config.actionTimeout });
    await this.update({ selectedURL: target });
    return this.status();
  }

  async uploadFiles(files) {
    if (!files.length) throw new WebUIError("NO_FILES", "Specify at least one absolute file path.");
    for (const file of files) {
      if (!path.isAbsolute(file) || !(await fs.stat(file)).isFile()) throw new WebUIError("INVALID_FILE", "Each upload must be an existing regular file with an absolute path.");
    }
    await this.editable();
    const page = await this.page(); const before = page.url();
    let input = page.locator('input[type="file"]').first();
    if (!await input.count()) {
      const button = await this.first(SELECTORS.upload);
      if (!button) throw new WebUIError("UPLOAD_UNAVAILABLE", "Gemini upload control is unavailable.");
      await button.click();
      const local = page.getByRole("menuitem", { name: /Upload files|上传文件|从设备上传/i }).first();
      await local.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
      if (await local.isVisible()) {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: this.config.actionTimeout }),
          local.click(),
        ]);
        await chooser.setFiles(files);
      } else {
        input = page.locator('input[type="file"]').first();
        if (!await input.count()) throw new WebUIError("UPLOAD_UNAVAILABLE", "Local file input was not found. Nothing was sent.");
        await input.setInputFiles(files);
      }
    } else await input.setInputFiles(files);
    await this.waitForUploads(files);
    if (page.url() !== before) throw new WebUIError("CONVERSATION_CHANGED", "Conversation changed during upload; nothing was sent.");
    return { uploaded: files.map((file) => path.basename(file)), sent: false };
  }

  async waitForUploads(files) {
    const page = await this.page();
    const names = files.map((file) => ({ full: path.basename(file), stem: path.basename(file, path.extname(file)) }));
    await page.waitForFunction(({ selector, names }) => {
      const previews = [...document.querySelectorAll(selector)].filter((e) => e.getClientRects().length && !e.closest('user-query, model-response'));
      return names.every(({ full, stem }) => previews.some((e) => {
        const text = e.querySelector('.gem-attachment-text')?.textContent.trim();
        return text ? text === full || text === stem : e.innerText.trim().split('\n').some((line) => line.trim() === full);
      })) && !previews.some((e) => e.querySelector('[role="progressbar"], [aria-busy="true"], mat-progress-spinner'));
    }, { selector: SELECTORS.attachments, names }, { timeout: this.config.actionTimeout });
  }

  async archiveConversation() {
    const page = await this.page(); const s = await this.snapshot(); await this.check(s);
    const messages = await page.locator(`${SELECTORS.user}, ${SELECTORS.assistant}`).evaluateAll((items, selectors) => items.map((e) => {
      const user = e.matches(selectors.user);
      const lines = user ? [...e.querySelectorAll('.query-text-line')] : [];
      return { role: user ? "user" : "assistant", text: lines.length ? lines.map((line) => line.innerText.trim()).join("\n") : (e.querySelector(user ? '.query-text' : selectors.answer) || e).innerText.trim() };
    }), SELECTORS);
    if (!messages.length) throw new WebUIError("EMPTY_CONVERSATION", "No loaded Gemini messages to archive.");
    await fs.mkdir(this.config.archiveDir, { recursive: true });
    const file = path.join(this.config.archiveDir, `gemini-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.md`);
    await fs.writeFile(file, `# Gemini conversation\n\nSource: ${s.url}\n\nScope: currently loaded messages; earlier history may not be loaded.\n\n` + messages.map((m) => `## ${m.role}\n\n${m.text}\n`).join("\n"), { mode: 0o600, flag: "wx" });
    return { path: file, messageCount: messages.length, completeHistory: false };
  }
}
