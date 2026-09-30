# Independent browser sessions — 0.7.0

`chat_send` can run multiple answers concurrently on the same provider. Give
each independent conversation a stable `session_id`. ChatGPT and Gemini each
reuse their existing signed-in browser; a session owns a separate tab.

```json
{"provider":"chatgpt","session_id":"paper-a","request_id":"paper-a-review-1","answer_tier":"Pro","web_search":true,"prompt":"Review question A and search primary sources."}
```

Submit another request with `session_id: "paper-b"` and a different request ID
while the first answer is running. Each send returns its own `task_id`; call
`chat_result` for each. A new session is created on first use, so `chat_new` is
not necessary. `answer_tier` and `web_search` currently apply to ChatGPT only.
Selecting the visible Pro tier is verified; this is not a guarantee of the
provider's hidden backend model routing.

For a follow-up, wait until that session's task completes, then send a new
`request_id` with the same `session_id`. Do not reuse a request ID with changed
content, session, model, tier or search settings. Request IDs remain unique
across the provider, not just inside a session.

`chat_status`, `chat_models`, `chat_select_model`, `chat_new`, `chat_history`,
`chat_open` and `chat_archive` also accept `session_id`. `chat_result`,
`chat_cancel` and `chat_abandon` recover it from the persisted task. Omitting
`session_id` uses the unmanaged legacy tab, retaining its existing guards.
An uncertain task blocks only its own session. It is never cleared to permit
unrelated new work. Two tabs cannot submit into the same active conversation.

## Isolation and limits

- Tabs are pinned by Chrome target ID, not active-tab order, page title or URL.
  Redirects and provisional conversation URLs do not change tab ownership.
- MCP process reconnects retain the binding and duplicate-send protection.
  A closed tab or restarted browser fails closed with `SESSION_TAB_MISSING`;
  no replacement tab is silently created and no prompt is resent. Inspect the
  original conversation manually. New independent work may use another name.
- Short browser operations are serialized; server-side answers can generate
  concurrently. Account-level send spacing, recovery cooldowns and rate-limit
  circuit breakers remain shared. Parallel sessions do not bypass site limits.
- A rate limit blocks all sessions on that provider. Never retry using another
  session or account to evade it. The provider's own concurrency quota applies.
- Cancellation verifies both the bound conversation and the last user prompt.
  Closing/cancelling one task does not stop another session's generation.
- Legacy tools do not operate on managed session tabs. Multiple unmanaged tabs
  are ambiguous and must be resolved explicitly, rather than selecting one.
- `chat_compare` retains its sequential same-provider model workflow. For
  concurrent same-provider work, use separate `chat_send` sessions.

## Upgrade and recovery

Restart **all** MCP connections after upgrading. Existing v1 task journals are
read without discarding records. The first named-session send writes journal
version 2, which retains legacy tasks alongside scoped tasks. Older releases
reject v2 instead of corrupting its records; rolling back application code does
not downgrade the journal. Do not delete journals to work around this guard.

`chat_tasks.active_task` remains the legacy task for compatibility;
`active_tasks` lists every live task with its session and state. Diagnostics
count all live sessions, and managed upgrades/rollbacks remain blocked while
any task is active. Health/status APIs remain observations, not login proofs.

This version also recognizes ChatGPT's `local-chatgpt:…` temporary URL. An old
uncertain task can be reconciled by `chat_result` if the original page and
expected user turn match; no abandoned tracking or repeated send is needed.

## Verification

Unit tests cover simultaneous live tasks, same-session exclusion, idempotency,
reconnect, cancellation isolation, legacy-task coexistence, settings failures,
journal validation, runtime-state isolation and provisional URL recovery.
Offline Chromium tests cover stable tab binding, redirects, untouched legacy
drafts, missing tabs, wrong-site navigation and ambiguous unmanaged tabs.
Run `npm test`, `npm run test:browser` and `npm run smoke`.
