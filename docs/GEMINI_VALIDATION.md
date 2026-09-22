# Gemini validation — 2026-09-22

Version: 0.3.0. Local environment: Windows, Node.js 24.14.0, installed Google Chrome.

## Verified

The staged source was exported to a clean directory and installed with `npm ci --ignore-scripts`, excluding unrelated local ChatGPT edits and private debug scripts.

- `npm test`: 49/49 passed, including existing ChatGPT regression tests.
- `npm run test:browser`: 11/11 passed in real headless Chromium using intercepted, synthetic Gemini pages. No live account or message was used.
- `npm run smoke`: 46 MCP tools registered, including 17 Gemini tools; local Gemini state retrieval passed over stdio.
- `npm pack --dry-run`: 24 publishable files; private `scripts/local-*` helpers excluded.
- Dependency installation/audit: zero known vulnerabilities with the committed lockfile. Existing patched versions of `fast-uri`, `hono` and `qs` were retained.
- `git diff --cached --check`: passed.

Browser tests cover complete responses and follow-up context, draft/attachment protection, direct input and file-chooser upload paths, model listing/selection, sidebar history, scoped Markdown export, timeout recovery without resending, conversation-change detection, logged-out pages, rate-limit UI and HTTP 429, cancellation, last-minute draft changes, persistent browser reconnect and explicit shutdown.

## Still required before live acceptance and publication

The dedicated Gemini page loaded successfully and its logged-out state was correctly identified through MCP. Google sign-in has not been completed. Actual Gemini responses, account-specific model menus and live uploads are therefore **not yet verified**. Fixture tests are not evidence of live-site compatibility.

1. Sign in manually in the dedicated Gemini browser (`node src/cli.js login --provider gemini` if needed).
2. Run `node scripts/verify-gemini.js --send` for two synthetic live MCP prompts and context-preserving follow-up.
3. Inspect and verify account-specific model/upload controls; update selectors if needed and rerun relevant tests.
4. Update this report with the actual live result before publication.

Linux/Windows CI definitions are included but remote GitHub CI has not run yet. No code has been pushed as part of this validation.
