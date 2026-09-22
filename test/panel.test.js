import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startPanel } from '../src/panel.js';

test('panel rejects missing token, foreign Origin, DNS rebinding and mutations', async (t) => {
  const kernel = { providers: new Map() };
  const panel = await startPanel(kernel); t.after(() => panel.close());
  const url = new URL(panel.url); const token = url.hash.slice(1); const endpoint = `${url.origin}/api/state`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 405);
  const rebinding = await new Promise((resolve, reject) => { const req = http.get(endpoint, { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(rebinding, 403);
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).report.sign_in_verified, false);
  const html = await (await fetch(url.origin)).text(); assert.ok(!html.includes(token)); assert.ok(html.includes('textContent'));
});
