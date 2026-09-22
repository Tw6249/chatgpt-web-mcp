#!/usr/bin/env node
// Explicit opt-in live acceptance. Never run this script in CI.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "gemini-live-acceptance", version: "0.3.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url))], stderr: "pipe" });
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  const value = JSON.parse(result.content[0].text);
  if (result.isError) throw new Error(`${name}: ${value.code || "ERROR"}: ${value.error}`);
  return value;
}
async function completed(result) {
  const deadline = Date.now() + 300000;
  while (!result.complete && result.pending && Date.now() < deadline) {
    console.log("Response pending; resuming the same send without resending.");
    result = await call("gemini_get_latest_response", { wait: true, timeoutMs: 60000 });
  }
  assert.equal(result.complete, true, "Response remains pending; resume waiting, never resend");
  return result;
}
try {
  await client.connect(transport);
  const status = await call("gemini_status");
  console.log(JSON.stringify({ signedIn: status.signedIn, busy: status.busy, draftPresent: status.draftPresent, pending: !!status.pending, model: status.model }));
  if (!status.signedIn) throw new Error("Manual Gemini login is required before live acceptance.");
  if (process.argv.includes("--send")) {
    assert.equal(status.draftPresent, false, "Do not discard a user draft");
    assert.equal(status.busy, false, "Do not interrupt an active answer");
    assert.equal(status.pending, null, "Resolve any existing pending send first");
    await call("gemini_new_chat");
    const first = await completed(await call("gemini_send_message", { prompt: "This is a software integration test. Remember the marker GEMINI_MCP_OK_7319. Reply with only that exact marker.", timeoutMs: 60000 }));
    assert.match(first.text, /GEMINI_MCP_OK_7319/);
    const second = await completed(await call("gemini_send_message", { prompt: "What exact marker did I ask you to remember in the previous message? Reply with only that marker.", timeoutMs: 60000 }));
    assert.match(second.text, /GEMINI_MCP_OK_7319/);
    console.log("PASS: live MCP send, complete response, browser reconnect, and context-preserving follow-up.");
  } else if (!process.argv.includes("--upload")) console.log("Status only. Add --send to explicitly create a test conversation and send two synthetic prompts.");
  if (process.argv.includes("--upload")) {
    const root = path.resolve(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(root, "gemini-live-acceptance-"));
    try {
      const file = path.join(directory, "gemini-acceptance.txt");
      await fs.writeFile(file, "GEMINI_FILE_OK_8426\n", "utf8");
      const current = await call("gemini_status");
      assert.equal(current.draftPresent, false); assert.equal(current.attachmentCount, 0); assert.equal(current.pending, null); assert.equal(current.busy, false);
      await call("gemini_write_prompt", { prompt: "Read the attached text file and reply with only the exact marker written inside it." });
      const uploaded = await call("gemini_upload_files", { files: [file] });
      assert.deepEqual(uploaded.uploaded, ["gemini-acceptance.txt"]);
      assert.equal((await call("gemini_status")).attachmentCount, 1);
      const answer = await completed(await call("gemini_submit_prompt", { wait: true, timeoutMs: 60000 }));
      assert.match(answer.text, /GEMINI_FILE_OK_8426/);
      console.log("PASS: live MCP upload, attachment detection, submit and file-content response.");
    } finally {
      assert.equal(path.dirname(directory), root);
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
} finally { await client.close(); }
