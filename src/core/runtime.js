import { ChatGPTBrowser } from '../browser.js';
import { GeminiBrowser } from '../gemini/browser.js';
import { chatgptProvider, geminiProvider } from '../providers/adapters.js';
import { TaskKernel } from './tasks.js';

export function createRuntime() {
  const chatgpt = new ChatGPTBrowser();
  const gemini = new GeminiBrowser();
  const chatgptAdapter = chatgptProvider(chatgpt), geminiAdapter = geminiProvider(gemini);
  chatgptAdapter.forSession = (sessionId) => chatgptProvider(new ChatGPTBrowser({ sessionId }));
  geminiAdapter.forSession = (sessionId) => geminiProvider(new GeminiBrowser(undefined, undefined, { sessionId }));
  const kernel = new TaskKernel([chatgptAdapter, geminiAdapter]);
  return { chatgpt, gemini, kernel, close: () => Promise.allSettled([chatgpt.close(), gemini.close(), ...[...kernel.sessions.values()].map(p => p.browser.close())]) };
}
