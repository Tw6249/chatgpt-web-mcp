import { z } from 'zod';
import { diagnose } from './diagnostics.js';

export function registerUnifiedTools(server, kernel) {
  const provider = z.enum([...kernel.providers.keys()]);
  const tool = (name, description, schema, handler) => server.tool(name, description, schema, async (input, extra) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await handler(input, extra.signal), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code || 'CHAT_ERROR', error: error.message }) }] }; }
  });
  const run = (id, method, args, signal, readOnly = false) => kernel.run(id, () => kernel.provider(id).browser[method](...args), { signal, readOnly, name: `chat_${method}` });
  tool('chat_providers', 'List installed providers and their supported capabilities. No browser access.', {}, async () => ({ providers: [...kernel.providers.values()].map(({ id, capabilities }) => ({ id, capabilities })) }));
  tool('chat_doctor', 'Inspect local executable, runtime and task-journal health. Does not open a browser or verify sign-in. Report excludes paths, conversation URLs, task IDs, responses and raw errors.', { provider: provider.optional() }, (i) => diagnose(kernel, i.provider ? [i.provider] : undefined));
  tool('chat_status', 'Read the selected provider page and local managed-task state.', { provider }, async (i, signal) => ({ ...await run(i.provider, 'status', [], signal, true), ...await kernel.list(i.provider, 1) }));
  tool('chat_models', 'List names actually available on the selected provider. Model names are provider-specific.', { provider }, (i, s) => run(i.provider, 'listModels', [], s));
  tool('chat_select_model', 'Select an exact available model name on one provider.', { provider, model: z.string().min(1) }, (i, s) => run(i.provider, 'selectModel', [i.model], s));
  tool('chat_new', 'Create a conversation on one provider. Managed tasks and provider drafts prevent unsafe switching.', { provider }, (i, s) => run(i.provider, 'newChat', [], s));
  tool('chat_send', 'Submit once and return a durable task_id. Supply a unique request_id; reuse the SAME request_id and content after a timeout. Replays never resend. Files must be explicitly authorized by the user. Prompt text is not stored; final responses are stored locally.', { provider, request_id: z.string().min(1).max(128), prompt: z.string().min(1), files: z.array(z.string().min(1)).max(10).default([]) }, (i, signal) => kernel.send(i, { signal }));
  tool('chat_result', 'Read/resume a durable task after reconnect or restart. Never sends. Completed results are read from the local journal. uncertain requires inspection; do not retry with a new request_id.', { task_id: z.string(), wait: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(300000).default(30000) }, (i, signal) => kernel.result(i.task_id, { ...i, signal }));
  tool('chat_cancel', 'Cancel ONLY the generation belonging to this task, after verifying conversation and prompt identity. A completed task stays completed. If cancellation cannot be confirmed, the reservation remains.', { task_id: z.string() }, (i, signal) => kernel.read(i.task_id, { signal, cancel: true }));
  tool('chat_tasks', 'List local task metadata without opening a browser or exposing prompt text. Supports state filtering and offset pagination; results include total and next_offset.', { provider, limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0), state: z.enum(['preparing', 'submitting', 'submitted', 'running', 'uncertain', 'completed', 'cancelled', 'failed', 'abandoned']).optional() }, (i) => kernel.list(i.provider, i.limit, i));
  tool('chat_abandon', 'Explicit recovery after inspecting an uncertain task: release local tracking only when the original page is idle. Does not undo delivery or clear drafts. Requires user authorization; never call automatically after a timeout. The same request_id will still never resend.', { task_id: z.string(), confirm: z.literal(true) }, (i, signal) => kernel.abandon(i.task_id, { confirm: i.confirm, signal }));
  tool('chat_history', 'List provider conversation history; inspect the returned scope/completeness information.', { provider, query: z.string().default(''), limit: z.number().int().min(1).max(50).default(20) }, (i, s) => run(i.provider, 'listHistory', [{ query: i.query, limit: i.limit }], s));
  tool('chat_open', 'Open a provider conversation URL. Refuses to switch away from a managed task.', { provider, url: z.string().url() }, (i, s) => run(i.provider, 'selectHistory', [i.provider === 'chatgpt' ? { url: i.url } : i.url], s));
  tool('chat_archive', 'Explicitly export the selected provider conversation to local Markdown. Provider-specific history completeness is preserved.', { provider }, (i, s) => run(i.provider, 'archiveConversation', [], s));
}
