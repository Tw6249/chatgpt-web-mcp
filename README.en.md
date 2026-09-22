# ChatGPT & Gemini Web MCP

A fork of [Goudu666/chatgpt-web-mcp](https://github.com/Goudu666/chatgpt-web-mcp) with Gemini web support. The original MIT license and author attribution are preserved.

## Unified interfaces and durable tasks (0.4.0)

Thirteen new `chat_*` tools share a provider-neutral coordinator while preserving all 46 legacy tools. `chat_send` accepts `provider` and a stable `request_id`; `chat_result` resumes by `task_id` after an MCP restart. Replays do not resend. Managed tasks prevent legacy tools from changing the same provider page until resolved. Task listing, verified cancellation and explicit recovery are included.

The new `web-chat-mcp` executable aliases the existing command. Restart the MCP connection after updating. Private journals, including completed responses, default to `~/.web-chat-mcp` (`WEB_CHAT_DATA_DIR` overrides it). See [architecture, usage and recovery](docs/UNIFIED_TASKS.md) for scope and limitations.

## Gemini support (0.3.0)

The existing MCP entry point now exposes both `chatgpt_*` and `gemini_*` tools. Existing ChatGPT names and configuration remain compatible. Gemini has a separate persistent browser profile, operation lock, rate-limit state, pending-send journal and archive directory.

```bash
npm ci
node src/cli.js doctor --provider gemini
node src/cli.js login --provider gemini
```

Sign in to Google/Gemini manually in the dedicated window. The server never reads your everyday browser profile or accepts passwords/cookies. Restart the MCP client connection after updating to discover the new tools; the entry point remains `src/index.js`.

Use `gemini_status`, `gemini_new_chat`, then `gemini_send_message`. A `pending: true` or `timedOut: true` result is **not completion**: resume with `gemini_get_latest_response` and `wait: true`, without resending. Send intent is persisted before clicking, so uncertain delivery survives process exits. Only user-confirmed manual inspection can resolve an uncertain send with `gemini_resolve_pending`.

For authorized attachments, use `gemini_write_prompt`, `gemini_upload_files` (absolute paths), and `gemini_submit_prompt`. Atomic `gemini_send_message` requires an empty composer. Drafts, attachments, and pending responses prevent accidental navigation or overwrites.

Additional tools: `gemini_list_models`, `gemini_select_model`, `gemini_list_history`, `gemini_select_history`, `gemini_archive_conversation`, `gemini_browser_lifecycle`, `gemini_circuit_breaker_status`, `gemini_clear_circuit_breaker`, and `gemini_close_browser`. Close the dedicated browser only when explicitly requested.

Model names come from the actual page. History and Markdown archives contain only currently loaded messages; they do not claim complete history. There is no private Gemini API, guessed model identity, Pro probing, or automatic 40-turn rotation. UI/account/language changes can make controls unavailable; the adapter stops with an error.

Sends and conversation/model changes are spaced by at least five seconds. Gemini HTTP 429 or rate-limit UI stops further actions, without retries or account switching. Clearing a breaker requires manual confirmation and enforces a further five-minute recovery period.

| Environment variable | Default |
| --- | --- |
| `GEMINI_WEB_DATA_DIR` | `~/.gemini-web-mcp` |
| `GEMINI_WEB_PROFILE` | `chrome-profile` under the data directory |
| `GEMINI_WEB_CHROME` | Auto-detected Chrome/Edge; falls back to `CHATGPT_WEB_CHROME` |
| `GEMINI_WEB_ARCHIVE_DIR` | `conversation-context` under the data directory |
| `GEMINI_WEB_HEADLESS` | `false` (manual login needs a visible window) |
| `GEMINI_WEB_ACTION_TIMEOUT_MS` | `20000` |
| `GEMINI_WEB_RESPONSE_TIMEOUT_MS` | `300000` |
| `GEMINI_WEB_SEND_INTERVAL_MS` | `5000` minimum |
| `GEMINI_WEB_CHANGE_INTERVAL_MS` | `5000` minimum |
| `GEMINI_WEB_RECOVERY_INTERVAL_MS` | `300000` minimum |

Validation: `npm test`, `npm run smoke`, `npm run test:browser`, and `npm pack --dry-run`. Browser integration tests intercept all requests with local fixtures and require no account or real sends. Install Chrome/Edge or run `npx playwright-core install chromium`. Live Gemini acceptance is separate and requires manual sign-in and low-frequency checks.

After signing in, explicitly run `node scripts/verify-gemini.js --send` to create a test conversation and send two synthetic prompts through MCP, checking completion, reconnect and follow-up context. Without `--send`, it only checks status. This script is excluded from CI.

Add `--upload` to test attachments: `node scripts/verify-gemini.js --send --upload`. It generates a temporary text file containing only a synthetic marker, uploads it, and verifies Gemini reads the marker. It never uploads your documents. See the [validation report](docs/GEMINI_VALIDATION.md) for the actual live acceptance results.

## Existing ChatGPT features

[中文说明](README.md)

An unofficial local MCP server that lets Codex and other MCP clients operate `chatgpt.com` through a dedicated persistent browser profile. It does not use OpenAI's official paid API or require an API key. Messages are sent through the UI; history reads may use the current web session's internal endpoint. It does not read a user's regular browser profile or place login credentials in MCP configuration.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by OpenAI. It depends on the ChatGPT web UI, which may change without notice. Account permissions, region, and workspace policy may also affect behavior. Do not use this project to bypass access controls, usage limits, or safety systems.

## Features

- Create normal and temporary chats and select chat history
- Write prompts, upload explicitly selected files, send messages, and read responses
- Discover models, reasoning levels, and answer tiers from the visible UI
- Keep the dedicated browser and ChatGPT page open between MCP calls
- Serialize browser control across MCP processes and apply conservative delays
- Stop on rate-limit text or non-history HTTP 429; history API 429 does not trip the global breaker or automatically retry that endpoint
- Use the default extreme tier with temporary Pro identity probes disabled by default, avoiding extra temporary chats and test messages
- Rotate conversations before the 40-turn cap, loading older lazy history and archiving the complete transcript first; direct submit calls are rejected at the cap
- Store only sanitized network error metadata

## Requirements

- Node.js 20+
- Google Chrome, Chromium, or Microsoft Edge
- A local stdio MCP client such as Codex
- A ChatGPT account that can be logged in manually

Common browser locations are detected on macOS, Windows, and Linux. Set `CHATGPT_WEB_CHROME` when auto-detection does not find your browser.

## Install

```bash
git clone https://github.com/Tw6249/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
npm run doctor
npm link
```

Log in through the dedicated browser:

```bash
chatgpt-web-mcp login
```

The browser profile is stored in `~/.chatgpt-web-mcp/chrome-profile` by default. Never commit or share that directory.

Add the server to Codex:

```bash
codex mcp add chatgpt-web -- chatgpt-web-mcp serve
codex mcp get chatgpt-web
```

If the Codex process cannot resolve the linked command, use an absolute project path:

```bash
codex mcp add chatgpt-web -- node /absolute/path/to/chatgpt-web-mcp/src/index.js
```

See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) for Codex MCP configuration concepts.

## CLI

```text
chatgpt-web-mcp serve    Start the stdio MCP server (default)
chatgpt-web-mcp login    Open the dedicated browser for manual login
chatgpt-web-mcp status   Inspect local browser state
chatgpt-web-mcp doctor   Check Node.js, browser detection, and local paths
chatgpt-web-mcp help     Show command help
```

## Configurable routing policy

Normal requests create a non-temporary chat with the available `极高` tier using `chatgpt_route_new_chat(requestPro=false)`.

**Temporary Pro identity probes are disabled by default** (`CHATGPT_WEB_PROBE_ENABLED=false`). Both `chatgpt_probe_pro_identity` and `requestPro=true` fail before opening a temporary chat or sending a probe; `forceProbe=true` does not bypass the switch. This avoids extra conversations and test requests. Explicitly selecting a Pro option that the UI actually offers is still possible, but actual model routing is not guaranteed.

Set `CHATGPT_WEB_PROBE_ENABLED=true` and restart the MCP server only if an experimental identity probe is needed. The existing experimental route probes the available tier and reads `model_slug`: mini falls back to the default tier, another nonempty slug is classified as `network-verified`, and a missing slug stops the route. **Non-mini does not mean Pro.** The probe does not force a Pro selection; its tool name and `requestPro` parameter remain for compatibility.

When enabled, a reliable probe result is reused while the same browser and page stay open, with a three-hour grace period after a detected close. Normal MCP calls only disconnect local control, so they do not start that timer. With probing disabled, cache expiry never triggers a probe or requires a new login.

These values can be changed without editing source code:

| Variable | Default |
| --- | --- |
| `CHATGPT_WEB_PROBE_ENABLED` | `false` |
| `CHATGPT_WEB_DEFAULT_TIER` | `极高` |
| `CHATGPT_WEB_PRO_TIER` | `Pro` |
| `CHATGPT_WEB_PROBE_PROMPT` | `你是什么模型？` |
| `CHATGPT_WEB_PROBE_ACCEPT_ID` | `gpt-5.6-pro` |
| `CHATGPT_WEB_PROBE_FALLBACK_ID` | `gpt-5.5-mini` |
| `CHATGPT_WEB_PROBE_ACCEPT_PATTERN` | GPT-5.6 Pro regular expression |
| `CHATGPT_WEB_PROBE_FALLBACK_PATTERN` | GPT-5.5 mini regular expression |
| `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS` | `10800000` (3 hours) |
| `CHATGPT_WEB_MAX_CONVERSATION_TURNS` | `40` |
| `CHATGPT_WEB_CONTEXT_ARCHIVE_DIR` | `~/.chatgpt-web-mcp/conversation-context` |

See [.env.example](.env.example). The project does not automatically load `.env`; inject variables through the MCP client, shell, or operating system.

## Optional refresh before a new chat

`CHATGPT_WEB_REFRESH_BEFORE_NEW_CHAT=false` by default. Set it to `true` and restart the MCP server to check drafts/attachments, reload the current page, then open a new chat through the UI. A failed reload or rate limit stops the operation without retrying.

This is separate from the existing refresh before sending. Enabling both usually means two reloads for a new-chat send, increasing requests and latency. This option is for stale-page troubleshooting, **not rate-limit prevention**. Small successful trials do not establish that another reload reduces rate limits. The browser and its page still remain open.

## Rate-limit policy and five-second defaults

- Page interactions: at least 1 second apart
- High-level site actions: at least 5 seconds apart
- Message sends: at least 5 seconds apart (`CHATGPT_WEB_SEND_INTERVAL_MS=5000`)
- Conversation changes: at least 5 seconds apart (`CHATGPT_WEB_CONVERSATION_CHANGE_INTERVAL_MS=5000`)
- Conversation changes after a completed answer: at least 5 seconds (`CHATGPT_WEB_POST_RESPONSE_CONVERSATION_COOLDOWN_MS=5000`)
- After initially opening ChatGPT: 6 seconds (`CHATGPT_WEB_PAGE_STARTUP_DELAY_MS=6000`)
- First site action after clearing a breaker: 5 minutes
- Independent history quiet period after a history rate limit: 5 minutes

**Five seconds is a minimum interval, not an operation duration or a guarantee against rate limits or account restrictions.** Loading, UI interactions, generation, and other waits add to it; messages are not sent concurrently. Existing client environment overrides still win: an explicit `30000` remains 30 seconds after upgrading. Increase the three intervals to `30000` if needed; stop instead of repeatedly retrying when a warning appears.

The five-minute breaker recovery and history quiet period are unchanged. The server does not automatically clear the breaker, dismiss warnings, retry HTTP 429, or close the persistent browser. History API 429 alone does not trip the global breaker: browser responses remain in the diagnostic log, and an unsuccessful direct history read uses the existing page-transcript fallback without retrying that endpoint. Explicit page-visible rate-limit warnings still stop operations. Missing observed API headers no longer cause another conversation page to open just for authentication priming.

The PR's stale-owner cleanup is preserved: when the recorded MCP process has exited, a subsequent operation automatically clears its generation marker. This rule does not clear markers with a live or missing owner PID, clear a rate-limit breaker, or close the browser.

## Privacy and limitations

- Login state, runtime state, and sanitized diagnostics live under `~/.chatgpt-web-mcp` by default.
- Upload tools only accept explicit absolute file paths.
- Diagnostics omit query strings, cookies, request and response bodies, and conversation identifiers.
- Response waiting uses in-page mutation events rather than page polling.
- Failed in-page navigation stops instead of repeatedly reloading ChatGPT.
- The ChatGPT web UI is not a stable API and selectors may require maintenance.
- Before automatic conversation rotation, the complete transcript (including older lazy-loaded messages) is written as a `0600` Markdown archive; use `chatgpt_archive_conversation` for explicit persistence.
- Neither a model's self-description nor its network label independently proves the serving model; a non-mini label is not a Pro guarantee.

## Development

```bash
npm ci
npm test
npm run smoke
npm pack --dry-run
```

CI performs offline unit tests and package checks only. It never logs in to ChatGPT or sends live requests. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
