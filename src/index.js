#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRuntime } from './core/runtime.js';
import { registerChatGPTTools } from './providers/chatgpt-tools.js';
import { chatgptInstructions } from './providers/chatgpt-policy.js';
import { registerGeminiTools } from './gemini/tools.js';
import { registerUnifiedTools } from './core/tools.js';

const runtime = createRuntime();
const { chatgpt, gemini, kernel } = runtime;
const server = new McpServer({ name: 'web-chat', version: '0.7.0' }, {
  instructions: 'For durable work, use chat_send with a stable request_id, then chat_result with task_id. For independent simultaneous tasks on one provider, use a different session_id for each conversation; reuse it for follow-ups. Each session owns a persistent browser tab. Reusing a request_id never resends. Never route user data to another provider without authorization. Browser sessions remain open and account rate limits stay shared. Legacy provider tools use the unmanaged tab and cannot mutate a page reserved by its managed task. The following routing guidance applies to legacy chatgpt_* tools: ' + chatgptInstructions(),
});
registerUnifiedTools(server, kernel);
registerChatGPTTools(server, chatgpt, kernel);
registerGeminiTools(server, gemini, kernel);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
await server.connect(new StdioServerTransport());
server.server.onclose = shutdown;
console.error('web-chat-mcp ready');
