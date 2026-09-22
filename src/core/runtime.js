import { ChatGPTBrowser } from '../browser.js';
import { GeminiBrowser } from '../gemini/browser.js';
import { chatgptProvider, geminiProvider } from '../providers/adapters.js';
import { TaskKernel } from './tasks.js';

export function createRuntime() {
  const chatgpt = new ChatGPTBrowser();
  const gemini = new GeminiBrowser();
  const kernel = new TaskKernel([chatgptProvider(chatgpt), geminiProvider(gemini)]);
  return { chatgpt, gemini, kernel, close: () => Promise.allSettled([chatgpt.close(), gemini.close()]) };
}
