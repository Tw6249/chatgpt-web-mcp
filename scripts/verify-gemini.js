#!/usr/bin/env node
// Explicit opt-in live acceptance. Never run this script in CI.
import assert from "node:assert/strict";
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
    const first = await call("gemini_send_message", { prompt: "This is a software integration test. Remember the marker GEMINI_MCP_OK_7319. Reply with only that exact marker.", timeoutMs: 300000 });
    assert.equal(first.complete, true, "Response is pending; resume waiting, never resend");
    assert.match(first.text, /GEMINI_MCP_OK_7319/);
    const second = await call("gemini_send_message", { prompt: "What exact marker did I ask you to remember in the previous message? Reply with only that marker.", timeoutMs: 300000 });
    assert.equal(second.complete, true);
    assert.match(second.text, /GEMINI_MCP_OK_7319/);
    console.log("PASS: live MCP send, complete response, browser reconnect, and context-preserving follow-up.");
  } else console.log("Status only. Add --send to explicitly create a test conversation and send two synthetic prompts.");
} finally { await client.close(); }
