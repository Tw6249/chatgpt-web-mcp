import { WebUIError } from './persistent-browser.js';

export function validateSessionId(id) {
  if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))) {
    throw new WebUIError('INVALID_SESSION', 'session_id must contain 1..64 letters, digits, underscores or hyphens.');
  }
  return id;
}

// Only generation/composer state is local. Rate limits, send intervals and
// authentication stay shared across every session in the same account.
export function sessionView(raw, id, fields) {
  if (!id) return raw;
  const view = { ...raw };
  for (const field of fields) view[field] = raw.sessions?.[id]?.[field] ?? null;
  return view;
}

export function mergeSessionView(raw, next, id, fields) {
  if (!id) return next;
  const result = { ...next, sessions: { ...next.sessions } };
  const local = { ...raw.sessions?.[id] };
  for (const field of fields) {
    local[field] = next[field] ?? null;
    if (Object.hasOwn(raw, field)) result[field] = raw[field];
    else delete result[field];
  }
  result.sessions[id] = local;
  return result;
}

export async function targetId(context, page) {
  const cdp = await context.newCDPSession(page);
  try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await cdp.detach(); }
}

// CDP target IDs survive reconnects and URL changes. Never guess by active
// tab, title or conversation URL, and never recreate a missing managed tab.
export async function sessionPage(context, { sessionId, bindings = {}, url, persist, beforeCreate = async () => {} }) {
  validateSessionId(sessionId);
  const pages = await Promise.all(context.pages().map(async page => ({ page, id: await targetId(context, page) })));
  const bound = sessionId && Object.hasOwn(bindings, sessionId) ? bindings[sessionId] : null;
  if (bound) {
    const match = pages.find(p => p.id === bound);
    if (!match) throw new WebUIError('SESSION_TAB_MISSING', 'The session tab was closed or its browser restarted. Do not resend; restore the original conversation or use a new session for new work.');
    if (new URL(match.page.url()).origin !== new URL(url).origin) throw new WebUIError('SESSION_NAVIGATED', 'The bound tab is no longer on the provider site. Restore its original page before resuming.');
    return match.page;
  }
  if (!sessionId) {
    const owned = new Set(Object.values(bindings));
    const origin = new URL(url).origin;
    const candidates = pages.filter(p => !owned.has(p.id) && new URL(p.page.url()).origin === origin);
    if (candidates.length > 1) throw new WebUIError('AMBIGUOUS_TAB', 'Multiple unmanaged provider tabs are open. Use a named session_id or leave one unmanaged provider tab.');
    if (candidates.length === 1) return candidates[0].page;
  }
  await beforeCreate();
  const page = await context.newPage();
  if (sessionId) await persist({ ...bindings, [sessionId]: await targetId(context, page) });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}
