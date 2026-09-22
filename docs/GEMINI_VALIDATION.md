# Gemini validation — 2026-09-22

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
