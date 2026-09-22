#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  stderr: "pipe",
});

transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

const client = new Client({ name: "chatgpt-web-mcp-smoke", version: "0.2.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools=${tools.tools.length}`);
  console.log(tools.tools.map((tool) => tool.name).join("\n"));
  assert.equal(tools.tools.filter((tool) => tool.name.startsWith('chatgpt_')).length, 29);
  assert.equal(tools.tools.filter((tool) => tool.name.startsWith('gemini_')).length, 17);
  for (const name of ['chat_providers', 'chat_status', 'chat_models', 'chat_select_model', 'chat_new', 'chat_send', 'chat_result', 'chat_cancel', 'chat_tasks', 'chat_history', 'chat_open', 'chat_archive', 'chat_abandon']) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
  }
  const providers = await client.callTool({ name: 'chat_providers', arguments: {} });
  assert.deepEqual(JSON.parse(providers.content[0].text).providers.map((p) => p.id), ['chatgpt', 'gemini']);
  assert.ok(tools.tools.some((tool) => tool.name === 'chat_doctor'));
  for (const name of ['chat_compare', 'chat_compare_result']) assert.ok(tools.tools.some((tool) => tool.name === name));
  assert.equal(tools.tools.length, 62);
  const doctor = await client.callTool({ name: 'chat_doctor', arguments: {} });
  assert.ok(!doctor.isError);
  assert.equal(JSON.parse(doctor.content[0].text).scope, 'local_only');
  for (const name of ["chatgpt_send_message", "chatgpt_status", "gemini_send_message", "gemini_get_latest_response", "gemini_status", "gemini_circuit_breaker_status"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
  }
  const localStatus = await client.callTool({ name: "gemini_circuit_breaker_status", arguments: {} });
  assert.ok(!localStatus.isError, "Gemini local state tool must work without opening a browser");
  if (process.argv.includes("--status")) {
    const status = await client.callTool({ name: "chatgpt_status", arguments: {} });
    console.log(JSON.stringify(status, null, 2));
  }
} finally {
  await client.close();
}
