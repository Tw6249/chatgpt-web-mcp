# Local diagnostics and task management — 0.5.0

Version 0.5 adds `chat_doctor`, task filtering/pagination, structured recovery guidance and management commands. There are now 60 MCP tools; all 46 provider-specific tools remain available.

## Command line

Run from a checkout with `node src/cli.js`, or use the installed `web-chat-mcp` executable:

```sh
node src/cli.js providers
node src/cli.js doctor
node src/cli.js doctor --provider gemini
node src/cli.js tasks --provider all --state uncertain --limit 20 --offset 0
node src/cli.js result gemini:REPLACE-WITH-TASK-UUID --wait --timeout 30000
node src/cli.js cancel gemini:REPLACE-WITH-TASK-UUID
node src/cli.js abandon gemini:REPLACE-WITH-TASK-UUID --confirm
```

`providers`, `doctor` and `tasks` do not open a browser. Doctor defaults to both providers. Task commands use the same journal, locking and browser adapters as MCP, so they can recover an operation after the MCP client disconnects. `result` can connect to the browser for an unfinished task; completed results are cached. There is no CLI send command and no automatic retry. Login/status commands and the original executable alias continue to work.

Output is JSON. Exit codes are **0** for successful execution, **1** for errors, failed/uncertain tasks, failed diagnostics or an expired wait, **2** for invalid arguments, and **130** for an interrupted management operation. A non-waiting result can return a running task with exit code 0; inspect its `state`. Ctrl+C interrupts waiting without cancelling generation or sending again. `cancel` verifies the task before stopping it. `abandon --confirm` is only appropriate after the user inspects the idle original page; it releases tracking without undoing delivery or deleting the request ID.

Task output is private: it may include conversation URLs, error text and, for `result`, response content. Do not paste it into a public issue. Use `doctor` for the redacted report instead.

## Diagnostics

`chat_doctor({})` checks both providers; `chat_doctor({"provider":"gemini"})` checks one. The CLI `doctor` and MCP tool use the same implementation. Checks cover:

- Node version and the configured browser executable's existence;
- readable local runtime state, rate-limit flags and pending-operation flags;
- whether the saved browser PID is alive (not a connectivity or identity check);
- operation/task lock snapshots, including incomplete lock metadata;
- task journal validity, counts by state and active-task state.

Diagnostics create no locks, launch no browsers and modify no state. The report uses allowlisted fields and excludes local paths, task IDs, conversation URLs, response text, account data and raw errors. It reports `scope: "local_only"` and `sign_in_verified: false`. `ok: true` means no failing local checks; warnings can still describe pending tasks or rate limits. This is not a sign-in, website compatibility or model availability test. Missing state files are normal before first use. Malformed journals fail closed. Lock observations can change immediately after inspection, and no lock is automatically deleted by doctor.

## Recovery and pagination

Task views now include `recovery.action`, `recovery.message` and `recovery.automatic_retry: false`. Guidance distinguishes manual sign-in, changed conversations, rate limits, uncertain delivery and ordinary waiting. It is informational and never performs the suggested operation.

`chat_tasks` accepts `state`, `offset` and `limit` and returns `total` and `next_offset` alongside the original fields. Follow `next_offset` until it is null. Ordering is newest creation time first with a deterministic ID tie-breaker. Pagination reflects the current journal on each call, so concurrent new tasks can shift offsets. No responses appear in task listings. Filters apply to the returned count; `active_task` still identifies any active provider task even when outside the filter.

State files remain private and use the same locations documented in [Unified tasks](UNIFIED_TASKS.md). Existing configuration and journals need no migration. This release does not add a web dashboard or automatic multi-provider routing.
