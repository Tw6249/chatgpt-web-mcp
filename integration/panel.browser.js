import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { geminiConfig } from '../src/gemini/config.js';
import { startPanel } from '../src/panel.js';

test('panel renders local status, filters tasks, exports redacted report and escapes data', async (t) => {
  const kernel = { directory: 'nonexistent-panel-fixture', providers: new Map(['chatgpt', 'gemini'].map((id) => [id, { id }])),
    provider: () => ({ localConfig: { executable: process.execPath, runtimeState: 'nonexistent-runtime-fixture', browserState: 'nonexistent-browser-fixture' } }),
    list: async (id) => ({ total: 1, next_offset: null, tasks: [{ task_id: `<img src=x onerror=alert(1)>-${id}`, state: id === 'gemini' ? 'uncertain' : 'completed', created_at: 0, recovery: { action: 'inspect_page' }, response: { text: 'PRIVATE_RESPONSE' }, conversation_url: 'https://private.example' }] }),
  };
  const panel = await startPanel(kernel); t.after(() => panel.close());
  const browser = await chromium.launch({ executablePath: geminiConfig().executable || chromium.executablePath(), headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(panel.url);
  await page.locator('#tasks tr').nth(1).waitFor();
  assert.equal(await page.locator('#cards .card').count(), 2);
  assert.equal(await page.locator('#tasks img').count(), 0);
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_RESPONSE'));
  assert.equal(new URL(page.url()).hash, '');
  await page.reload(); await page.locator('#tasks tr').nth(1).waitFor();
  await page.selectOption('#provider', 'gemini'); assert.equal(await page.locator('#tasks tr').count(), 1);
  await page.selectOption('#state', 'completed'); assert.equal(await page.locator('#tasks tr').count(), 0);
  await page.selectOption('#provider', ''); await page.selectOption('#state', '');
  const downloadPromise = page.waitForEvent('download'); await page.click('#download');
  const download = await downloadPromise; assert.equal(download.suggestedFilename(), 'web-chat-diagnostics.json');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
