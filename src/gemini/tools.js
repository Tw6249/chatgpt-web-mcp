import { z } from "zod";
import { GeminiBrowser } from "./browser.js";
import { TaskKernel } from '../core/tasks.js';
import { geminiProvider } from '../providers/adapters.js';

export function registerGeminiTools(server, browser = new GeminiBrowser(), kernel = new TaskKernel([geminiProvider(browser)])) {
  const readOnly = new Set(['gemini_status', 'gemini_browser_lifecycle', 'gemini_get_latest_response', 'gemini_circuit_breaker_status', 'gemini_clear_circuit_breaker']);
  const timeout = z.number().int().min(1000).max(900000).optional();
  const waitOptions = { wait: z.boolean().default(true), timeoutMs: timeout };
  const tool = (name, description, schema, handler) => server.tool(name, description, schema, async (input, extra) => {
    try {
      const result = await kernel.run('gemini', () => handler(input), { signal: extra.signal, readOnly: readOnly.has(name), name });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code || "GEMINI_ERROR" }) }] };
    }
  });
  tool("gemini_status", "Read Gemini sign-in, model, draft, generation and pending-send status in its dedicated browser. Manual Google login may be required.", {}, () => browser.status());
  tool("gemini_browser_lifecycle", "Read local Gemini browser/state information without opening a web page. Keep this browser running by default.", {}, () => browser.browserLifecycle());
  tool("gemini_new_chat", "Open a new Gemini conversation. Refuses to discard drafts, attachments or pending responses.", {}, () => browser.newChat());
  tool("gemini_write_prompt", "Write a Gemini draft without sending. Existing drafts are protected; append must be explicitly requested.", { prompt: z.string().min(1), append: z.boolean().default(false) }, ({ prompt, append }) => browser.writePrompt(prompt, { append }));
  tool("gemini_upload_files", "Upload explicitly user-authorized local files to Gemini. Absolute paths only; does not send the draft.", { files: z.array(z.string().min(1)).min(1).max(10) }, ({ files }) => browser.uploadFiles(files));
  tool("gemini_submit_prompt", "Submit the existing Gemini draft once. On timeout/uncertain delivery, read the pending response instead of resending.", waitOptions, (input) => browser.submitPrompt(input));
  tool("gemini_send_message", "Write and send a new Gemini prompt atomically. Requires an empty composer. Does not retry uncertain sends or rate limits. Completion requires a new response with finished UI controls.", { prompt: z.string().min(1), ...waitOptions }, (input) => browser.sendMessage(input));
  tool("gemini_get_latest_response", "Read the latest Gemini response. With wait=true, resume waiting for a pending send without resending. timedOut=true is not completion.", { wait: z.boolean().default(false), timeoutMs: timeout }, (input) => browser.getLatestResponse(input));
  tool("gemini_resolve_pending", "Only after the user manually checks an uncertain send, clear its pending marker. Never resends or stops an active generation.", { confirmed: z.literal(true) }, (input) => browser.resolvePending(input));
  tool("gemini_list_models", "List model/mode names actually offered by the current Gemini page; do not guess model names.", {}, () => browser.listModels());
  tool("gemini_select_model", "Select one exact available model/mode name returned by gemini_list_models.", { model: z.string().min(1) }, ({ model }) => browser.selectModel(model));
  tool("gemini_list_history", "List currently loaded Gemini sidebar conversations. Does not promise complete history or server-side search.", { query: z.string().default(""), limit: z.number().int().min(1).max(50).default(20) }, (input) => browser.listHistory(input));
  tool("gemini_select_history", "Open an existing Gemini conversation URL. Refuses to discard drafts or pending responses.", { url: z.string().url() }, ({ url }) => browser.selectHistory(url));
  tool("gemini_archive_conversation", "Explicitly save currently loaded Gemini messages as a local Markdown file. Earlier unloaded history is not included and is not claimed complete.", {}, () => browser.archiveConversation());
  tool("gemini_circuit_breaker_status", "Read local Gemini rate-limit/pending-send state without accessing the website.", {}, () => browser.circuitBreakerStatus());
  tool("gemini_clear_circuit_breaker", "Only after the user manually confirms Gemini's limit has cleared, reset the local breaker and apply a five-minute recovery cooldown.", { confirmed: z.literal(true) }, (input) => browser.clearCircuitBreaker(input));
  tool("gemini_close_browser", "Close Gemini's dedicated browser ONLY when the user explicitly asks to close it. Pending-send state is retained.", {}, () => browser.runtime.terminate());
  return browser;
}
