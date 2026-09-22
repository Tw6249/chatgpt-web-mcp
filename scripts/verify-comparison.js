#!/usr/bin/env node
// Explicit live acceptance. Targets must be names observed in chat_models.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const { values } = parseArgs({ options: { send: { type: 'boolean' }, target: { type: 'string', multiple: true }, 'request-id': { type: 'string' } } });
if (!values.send || !values.target?.length) throw new Error('Use --send --target "provider:exact model" at least twice. This creates separate synthetic conversations.');
const targets = values.target.map((value) => { const i = value.indexOf(':'); return { provider: value.slice(0, i), model: value.slice(i + 1) }; });
const request_id = values['request-id'] || randomUUID();
const marker = `COMPARE_OK_${createHash('sha256').update(request_id).digest('hex').slice(0, 10)}`;
const input = { request_id, prompt: `Software integration test. Reply with only this exact marker: ${marker}`, targets, timeoutMs: 60000 };
let client;
async function connect() {
  client = new Client({ name: 'comparison-acceptance', version: '0.6.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.js', import.meta.url))], stderr: 'pipe' });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk)); await client.connect(transport);
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  const value = JSON.parse(result.content[0].text);
  if (result.isError) throw new Error(`${value.code}: ${value.error}`);
  return value;
}
try {
  console.log(`Acceptance request_id=${request_id}; reuse this ID and targets if interrupted.`);
  await connect(); let result = await call('chat_compare', input);
  await client.close(); await connect();
  const deadline = Date.now() + 300000;
  while (!result.complete && Date.now() < deadline) {
    console.log(JSON.stringify(result.targets.map((t) => ({ provider: t.provider, model: t.model, state: t.task?.state || 'not_started', code: t.error?.code || t.task?.error?.code }))));
    if (result.targets.some((t) => t.task?.state === 'uncertain')) {
      await delay(3000);
      result = await call('chat_compare_result', { comparison_id: result.comparison_id });
    } else result = await call('chat_compare', input);
  }
  const replay = await call('chat_compare', input);
  assert.equal(replay.comparison_id, result.comparison_id);
  result = await call('chat_compare_result', { comparison_id: result.comparison_id });
  assert.equal(result.all_succeeded, true, JSON.stringify(result.targets.map((t) => ({ provider: t.provider, model: t.model, state: t.task?.state, code: t.task?.error?.code }))));
  for (const target of result.targets) assert.ok(target.task.response.text.includes(marker));
  assert.equal(new Set(result.targets.map((t) => t.task.task_id)).size, targets.length);
  console.log(`PASS ${targets.length} explicit targets: same question, separate answers, restart and replay.`);
} finally { await client?.close(); }
