'use strict';
// Direct-handler tests for netlify/functions/chat-lead.js.
//
// functions-smoke.test.mjs exercises the same function over HTTP through the
// Netlify CLI, which is the right place for runtime-shape checks — but the CLI
// reloads the module per invocation, so module-level state (the per-IP rate
// buckets) can't be observed there. These tests call the handler in-process.
const test = require('node:test');
const assert = require('node:assert/strict');

// Fresh module per file run; the rate buckets are module-level.
delete require.cache[require.resolve('../../netlify/functions/chat-lead.js')];
const { handler } = require('../../netlify/functions/chat-lead.js');

const lead = (i, headers = {}) => ({
  httpMethod: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ name: `Lead ${i}`, email: `l${i}@example.com`, role: 'Broker', message: 'unit test lead, at least ten characters long.' }),
});

// The handler's own Netlify-Forms forward must never leave the test process.
const origFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => ({ ok: true, status: 200 }); });
test.after(() => { globalThis.fetch = origFetch; });

test('CORS reflects only our own origins; a foreign Origin gets the canonical origin, never *', async () => {
  const foreign = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.statusCode, 204);
  assert.equal(foreign.headers['access-control-allow-origin'], 'https://oxfordra.net');
  const own = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://www.oxfordra.net' } });
  assert.equal(own.headers['access-control-allow-origin'], 'https://www.oxfordra.net');
  assert.equal(own.headers.vary, 'Origin');
  const none = await handler({ httpMethod: 'OPTIONS', headers: {} });
  assert.equal(none.headers['access-control-allow-origin'], 'https://oxfordra.net');
});

test('a burst of leads from one IP is rate limited: 5 accepted, the 6th is 429 with retry-after', async () => {
  const ip = { 'x-nf-client-connection-ip': '203.0.113.50' };
  for (let i = 0; i < 5; i++) {
    const r = await handler(lead(i, ip));
    assert.equal(r.statusCode, 200, `lead ${i} should be accepted`);
  }
  const sixth = await handler(lead(5, ip));
  assert.equal(sixth.statusCode, 429);
  assert.deepEqual(JSON.parse(sixth.body), { ok: false, error: 'rate_limited' });
  assert.ok(Number(sixth.headers['retry-after']) > 0, '429 must carry retry-after');
  // Another IP is unaffected.
  const other = await handler(lead(9, { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }));
  assert.equal(other.statusCode, 200);
});

test('the limiter is checked before body parsing, so malformed spam cannot bypass it', async () => {
  const ip = { 'x-nf-client-connection-ip': '203.0.113.51' };
  for (let i = 0; i < 5; i++) await handler(lead(i, ip));
  const r = await handler({ httpMethod: 'POST', headers: ip, body: '{not json' });
  assert.equal(r.statusCode, 429);
});
