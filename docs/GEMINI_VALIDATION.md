# Gemini validation

## 0.7.4 initialization correction — 2026-10-06

New named tabs previously called `newChat()` immediately after navigation. If Gemini had not mounted its composer, this reported `LOGIN_REQUIRED` for a signed-in account; a later reconnect skipped the incomplete initialization. The controller now waits for the composer or explicit sign-in UI, marks initialization only after readiness, and avoids the second navigation. A loading timeout reports `PAGE_NOT_READY`. Retrying initialization on a bound tab preserves its draft.

Validation: 99 unit tests, 47 offline browser tests, and the 62-tool MCP smoke check passed. Regression coverage includes delayed app mounting, one navigation per new tab, a genuine signed-out page, loading timeout, and preservation of a draft when reconnecting after incomplete initialization.

Live diagnosis used only the synthetic question “模型预测控制是什么？” with 3.8 Flash. Earlier Extended thinking tests returned capability refusals on both first and subsequent turns, although one follow-up succeeded; retrying is therefore not a guaranteed workaround. Two fresh conversations with Extended thinking off returned substantive answers. After the initialization correction, a fresh Extended thinking conversation also returned a substantive first answer. This verifies the concrete initialization defect and a working live path, but does not establish that it caused every provider refusal. A completed transport task is not proof that the response satisfies the question. Do not silently downgrade thinking, send warm-up prompts, or automatically duplicate a refused request.

Additional live checks after the correction: Extended thinking first turns produced one substantive answer and two capability refusals across three fresh sessions. One refusal occurred without reselecting the inherited model, ruling out redundant model selection as a necessary condition. The two thinking-off controls both answered. These are small, single-account diagnostic samples, not reliability estimates. The initialization fix does not resolve the remaining intermittent refusal behavior, and no server-side root cause is established.

## Historical validation — 2026-09-22

Version: 0.3.0. Local environment: Windows, Node.js 24.14.0, installed Google Chrome. Original ChatGPT tools and unrelated local edits were preserved.

## Automated checks

- `npm test`: 50/50 passed, including existing ChatGPT regression tests.
- `npm run test:browser`: 13 offline Chromium integration cases covering the live DOM variants below.
- `npm run smoke`: 46 MCP tools registered, including 17 Gemini tools; local Gemini state retrieval passed over stdio.
- `npm pack --dry-run`: private `scripts/local-*` helpers excluded; Gemini modules included.
- `npm audit --omit=dev`: zero known vulnerabilities with the committed lockfile. Existing patched versions of `fast-uri`, `hono` and `qs` were retained.
- `git diff --cached --check`: passed.

Browser fixtures intercept all requests: they never access a live account or send a real prompt. They cover final answers and multi-line prompts, follow-up context, drafts and attachments, input/file-chooser uploads, model/settings menu separation, selection confirmation, sidebar history, delayed history loading, scoped Markdown archives, timeout recovery without resending, prevention of stale-answer reads, conversation-change detection, authentication, HTTP 429, cancellation, last-minute draft changes and browser reconnect/shutdown.

## Live Gemini acceptance

After the user manually signed in, the following were verified through the real stdio MCP server:

- `node scripts/verify-gemini.js --send --upload`: passed. A new test conversation received a synthetic marker; a subsequent tool call remembered it after browser reconnect. A generated temporary text file was uploaded and its distinct marker was returned correctly by Gemini. No user document was uploaded.
- Model listing and selection: actual mode rows were discovered; switching to another available mode and back was verified using the menu's selected state. The separate extended-thinking setting was excluded from model rows.
- Attachment detection: the current composer reported one uploaded file and none after submission; historical attachments did not contaminate subsequent sends.
- Markdown archive, new conversation, reopening the saved test conversation, reading its last response and finding it in the loaded sidebar: passed.
- An earlier slow attachment response exercised timeout recovery: the existing send was resumed and completed without resending.
- Dedicated browser remained open; login data stayed outside the repository.

Real-page differences found and fixed during acceptance:

1. Hidden, truncated screen-reader announcements inside user messages must not enter prompt acknowledgement hashes or archives.
2. Model descriptions and settings are distinct from model names; selected state may use a CSS class.
3. The upload menu can be labelled `Upload & tools`, and file chips can omit extensions while a hidden tooltip retains the full filename.
4. Opening a history URL mounts the composer before messages; selection now waits for the transcript or active-generation UI.
5. While a new response has not appeared, a pending read must not return the previous turn's answer as its content.

## Scope

Acceptance covers this account and the available English Gemini UI on the date above. Model availability and UI layout can change. History and archives include only currently loaded messages and explicitly do not claim complete history. No provider limit was bypassed. Linux and Windows CI jobs provide additional automated validation on GitHub.
