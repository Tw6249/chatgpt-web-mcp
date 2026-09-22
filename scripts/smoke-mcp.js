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
