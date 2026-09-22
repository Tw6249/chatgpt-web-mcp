# Unified providers and durable tasks — 0.4.0

This fork is maintained at [Tw6249/chatgpt-web-mcp](https://github.com/Tw6249/chatgpt-web-mcp). The original MIT license and attribution remain in place. Version 0.4 extracts provider tool registration and ChatGPT policy from the server bootstrap, adds a common task coordinator, and retains all 46 legacy tools. There are 13 new provider-neutral tools (59 total).

## Quick start

Existing installations continue using `node src/index.js` or `chatgpt-web-mcp serve`. The additional `web-chat-mcp` executable is an alias. Restart your MCP connection after updating. No API key is required; each provider still uses its own signed-in dedicated browser.

1. Call `chat_providers` to discover capabilities.
2. Call `chat_new({"provider":"gemini"})` when a new conversation is wanted. Existing drafts, attachments and pending work remain protected.
3. Call `chat_send({"provider":"gemini","request_id":"my-operation-001","prompt":"Hello"})`. Use `chatgpt` for ChatGPT.
4. Save the returned `task_id`. Call `chat_result({"task_id":"gemini:…","wait":true,"timeoutMs":30000})`.
5. If the tool connection fails, repeat **the same request_id and content**, or resume with `chat_result`. Neither operation resends an existing request.

Use a new request ID for an intentionally new turn. Reusing an ID with different prompt text or attachment paths raises `IDEMPOTENCY_CONFLICT`. IDs are scoped by provider. Attachment path contents are not hashed: replaying an existing ID does not reread or upload changed files.

## Tools

| Tools | Purpose |
| --- | --- |
| `chat_providers`, `chat_status` | Provider capabilities, page and task state |
| `chat_models`, `chat_select_model` | Discover and select actual provider model names |
| `chat_new`, `chat_open`, `chat_history` | Conversation navigation and scoped history |
| `chat_send`, `chat_result`, `chat_tasks` | Durable submission, recovery and metadata |
| `chat_cancel` | Stop a generation after verifying its conversation and user turn |
| `chat_abandon` | Explicitly release tracking for an idle, inspected original page |
| `chat_archive` | Explicit local conversation export with provider-specific scope |

## State and recovery

The state sequence is `preparing → submitting → submitted/running → completed`. Preflight failures become `failed`; confirmed stops become `cancelled`. A crash or inconclusive page observation becomes `uncertain`. These are local observations, not a claim of server-side exactly-once delivery.

Before the first possible send, the task is written atomically to disk. A provider-specific cross-process lock covers each operation. While a task is active, legacy and unified page-changing tools are blocked for that provider; the other provider remains independently usable. Result waits release locks between observations. There is no background worker or automatic resend: reading a result reconciles the persisted baseline with the current page URL, user turn count, prompt hash and response state.

If the page was changed manually, return to the task's saved conversation in its dedicated browser, then call `chat_result`. Do not create a new request to compensate for an uncertain send. After the user has inspected an idle original page, `chat_abandon({"task_id":"…","confirm":true})` can release local tracking. It does not clear drafts, undo delivery, or assert that the response completed. The original request ID stays reserved. An active answer must be handled with `chat_cancel`, which refuses to stop another conversation's generation.

The local journal defaults to `~/.web-chat-mcp/<provider>/tasks.json`. `WEB_CHAT_DATA_DIR` overrides its root. Keep this path stable and shared by MCP processes controlling the same browser profile. Journals contain completed response text and private conversation URLs; do not publish them. They have no automatic expiration, because deleting an entry removes its duplicate-send protection. Browser profiles and archives remain in their existing provider-specific locations.

## Architecture and boundaries

- `src/index.js`: server bootstrap, provider registration, shutdown.
- `src/core/tasks.js`: task journal, idempotency, locking, recovery, cancellation.
- `src/core/tools.js`: provider-neutral MCP contracts.
- `src/providers/adapters.js`: provider observation and send contracts.
- `src/providers/chatgpt-tools.js`, `chatgpt-policy.js`: legacy ChatGPT tools and policy.
- `src/browser.js`, `src/gemini/`: existing provider browser implementations.

This release shares orchestration, not every browser implementation detail. ChatGPT's established browser engine remains in place. Legacy sends do not retroactively create durable task IDs. Completion and cancellation depend on observable page controls; layout changes, unloaded history and user navigation may produce `uncertain`. Gemini history/archives cover loaded messages only. No automatic provider fallback, account switching, or model-name mapping occurs.

## Verification

Run `npm test`, `npm run smoke`, and `npm run test:browser`. Browser tests intercept all requests with local fixtures; they need Chromium but no account. Install fixture Chromium with `npx playwright-core install chromium` if no local Chrome/Edge is available.

Live acceptance is opt-in: `node scripts/verify-unified.js --send` creates one synthetic Gemini conversation, sends a marker, restarts the MCP server, replays the request ID, then verifies the recovered and cached result. Add `--chatgpt` for ChatGPT. Without `--send`, it only lists capabilities. Do not run live acceptance in CI.

Local acceptance on 2026-09-22 passed 62 unit tests, 15 offline Chromium tests and MCP discovery of 59 tools. Both signed-in ChatGPT and Gemini passed the live restart/replay/result scenario. The ChatGPT run exposed a temporary `/c/WEB:…` URL transition; its adapter now recognizes provisional addresses, with a dedicated regression test. Dependency audit reported zero vulnerabilities at validation time. These checks cover the tested UI/account configuration and do not guarantee future website compatibility.
