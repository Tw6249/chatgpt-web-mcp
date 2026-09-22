# Multi-model comparisons and managed installations — 0.6.0

## Ask the same question of several models

Use `chat_models` for each provider to discover exact available names. Then call `chat_compare` with a stable request ID, a question, and **2–6 explicit provider/model pairs**:

```json
{
  "request_id": "comparison-001",
  "prompt": "Explain the tradeoffs between these two approaches…",
  "targets": [
    { "provider": "chatgpt", "model": "EXACT_NAME_FROM_CHAT_MODELS" },
    { "provider": "gemini", "model": "EXACT_NAME_FROM_CHAT_MODELS" }
  ],
  "timeoutMs": 30000
}
```

Each target gets a fresh conversation and its own durable task. Existing drafts, attachments and active tasks prevent switching. Providers can run independently; different models on one provider run sequentially to avoid competing for the same page. Names are the website's model labels, not a guarantee of an underlying model identity. There is no automatic provider fallback, model substitution, evaluation, ranking or answer synthesis. Do not include another provider unless the user authorized sharing the question with it.

The result contains `comparison_id`, each target's task and separate answer, `complete`, `all_succeeded`, and `needs_run`. `complete` means every child is terminal; inspect `all_succeeded` and individual states for failures. A failed preflight is not retried. An uncertain child pauses remaining targets on that provider while other providers can finish. The wait budget bounds observation and scheduling; browser actions have their own timeouts and may exceed that budget.

`chat_compare_result({"comparison_id":"compare:…"})` only observes existing tasks. It never sends. To continue **unsent** targets after a timeout or restart, repeat `chat_compare` with the **same request ID, prompt and ordered targets**. Child IDs are deterministic and use the task kernel's duplicate-send protection. Changing input under the same ID fails. Already completed children are read from their journals. Cancel a running child with `chat_cancel(task_id)`; no sibling is cancelled implicitly.

Comparison journals under `WEB_CHAT_DATA_DIR/comparisons` contain target metadata and a fingerprint, not the prompt. Task journals contain answers. A restart therefore needs the original prompt again only to start targets that have not been sent. Keep all these records private and stable; deleting journals destroys replay protection.

Live acceptance is opt-in:

```sh
node scripts/verify-comparison.js --send --target "chatgpt:EXACT_MODEL" --target "gemini:EXACT_MODEL" --request-id "my-test-001"
```

The script creates synthetic conversations, restarts MCP, verifies each answer and replays the request. Use discovered names; the examples above are placeholders. Gemini service-error text is reported as `PAGE_ERROR`, not a successful answer. No retry is sent automatically.

## One command family for installation and maintenance

Prerequisites: Node.js 20+, npm, Git and Chrome/Edge. From a checkout, run `npm ci`, then:

```sh
node src/cli.js setup
node src/cli.js login --provider all
node src/cli.js doctor
node src/cli.js upgrade
node src/cli.js rollback
node src/cli.js panel
node src/cli.js report --out /ABSOLUTE/PATH/diagnostics.json
```

`web-chat-mcp` and `chatgpt-web-mcp` are equivalent installed executable aliases. `npm run setup`, `npm run upgrade`, `npm run rollback` and `npm run panel` are also available. `login` defaults to both providers; `--provider chatgpt` or `--provider gemini` chooses one. Login recognizes already signed-in browsers and otherwise waits for manual sign-in. Credentials are never passed to the program. Existing active tasks block login page operations.

### Setup and the stable MCP entry point

`setup` installs from **Tw6249/chatgpt-web-mcp**, the maintained repository. It clones into a private staging directory, runs `npm ci --ignore-scripts`, unit tests and MCP smoke tests, and activates only after they pass. Browser tests are run by project CI, not on every local upgrade. The initial install does not modify an existing source checkout, browser profile or client configuration.

The default install root is `~/.web-chat-mcp/install`; override it with `WEB_CHAT_INSTALL_DIR`. Setup prints an MCP `command`/`args` configuration and writes `mcp-config.json` there. **Point your MCP client at that generated `launch.mjs serve` entry point** to use managed versions. A client still pointing directly at a source checkout continues to use that checkout, independently of managed upgrade/rollback. Configure this once and restart the MCP connection after version changes.

### Upgrade and rollback

`upgrade` fetches the maintained `main` branch by default. `--ref TAG_OR_FULL_COMMIT` selects another revision from that repository. Release directories are named by full commit IDs; existing ones are not overwritten. Activation uses an atomic manifest update and preserves the previous revision. Tracked modifications in an installed release prevent its activation. Existing tasks/pending sends or damaged local state block a switch. Checks run again immediately before activation, but no currently running MCP process is forcibly stopped.

`rollback` verifies and smoke-tests the previous local release, then switches the manifest. It needs no download and can switch back again. The managed launcher retains a maintenance-capable revision for upgrade/rollback commands, even when the selected MCP runtime predates these commands. Running connections keep their loaded code until restarted. Browser profiles and task journals are not rolled back or deleted; compatibility with very old revisions is not guaranteed, so use supported revisions and resolve active work first.

Failed validation keeps the active manifest unchanged. `doctor`/`report` identify the failing installation stage without publishing raw command output. Private `install-debug.log` contains details for local inspection. Releases and staging directories are retained, including failed candidates; there is no automatic cleanup or removal of rollback data.

## Local status panel and fault reports

`panel --port 0` chooses an available port and prints a local URL; a fixed port is optional. Open the printed URL in your browser. The server binds only to **127.0.0.1**. A random token authorizes the data API; other origins, wrong Host headers and non-GET requests are rejected. The panel is read-only and does not launch provider browsers, send prompts or cancel tasks. Ctrl+C stops it.

The panel shows provider health, managed version and up to 100 recent tasks per provider. Filter by provider/state and refresh on demand. It omits prompts, answers, raw errors and conversation URLs. Task IDs remain local metadata. The download button exports only the redacted diagnostics report, not the task table. Do not share the panel URL token.

`report` prints the same redacted diagnostics as JSON; `--out` saves to a new absolute path and refuses to overwrite existing files. `doctor` reports local executables, runtime flags, lock snapshots, task-journal health and managed-installation state. It does **not** prove website sign-in or availability. Existing task-management commands and all 46 legacy MCP tools remain available. Version 0.6 exposes 62 MCP tools in total.
