#!/usr/bin/env node
// Explicit opt-in live test: starts one synthetic conversation. Never run in CI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const provider = process.argv.includes('--chatgpt') ? 'chatgpt' : 'gemini';
let client;
async function connect() {
  client = new Client({ name: 'unified-live-acceptance', version: '0.4.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.js', import.meta.url))], stderr: 'pipe' });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await client.connect(transport);
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  const value = JSON.parse(result.content[0].text);
  if (result.isError) throw new Error(`${name}: ${value.code}: ${value.error}`);
  return value;
}
try {
  await connect();
  if (!process.argv.includes('--send')) {
    console.log(JSON.stringify(await call('chat_providers', {})));
    console.log('Add --send to create a synthetic test conversation. Default: Gemini; --chatgpt selects ChatGPT.');
  } else {
    await call('chat_new', { provider }); // Provider guard preserves drafts and pending answers.
    const marker = `UNIFIED_MCP_OK_${randomUUID().slice(0, 8)}`;
    const input = { provider, request_id: randomUUID(), prompt: `Software integration test. Reply with only this exact marker: ${marker}` };
    const task = await call('chat_send', input);
    assert.equal(task.state, 'submitted', JSON.stringify(task.error));
    console.log(`Submitted ${task.task_id}; restarting MCP server before reading result.`);
    await client.close(); await connect();
    const replay = await call('chat_send', input);
    assert.equal(replay.task_id, task.task_id); assert.equal(replay.replayed, true);
    const result = await call('chat_result', { task_id: task.task_id, wait: true, timeoutMs: 300000 });
    assert.equal(result.state, 'completed', JSON.stringify(result.error)); assert.ok(result.response.text.includes(marker));
    const cached = await call('chat_result', { task_id: task.task_id });
    assert.deepEqual(cached.response, result.response);
    console.log(`PASS ${provider}: durable send, process restart, idempotent replay, verified answer, cached result.`);
  }
} finally { await client?.close(); }
