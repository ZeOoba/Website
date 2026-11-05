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

// ---- No silent lead loss (2026-11-05 review) ----
// Netlify's native email notification for the `chat-lead` form only fires when the Forms row exists. When the
// server-side forward fails, the lead used to be dropped while the visitor was told "we will be in touch".
const { _resetCacheForTests: resetGraphToken } = require('../../netlify/functions/_shared/graph-auth.js');
const GRAPH_ENV = { GRAPH_SEND_FROM: 'no-reply@oxfordra.net', GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' };
function withGraphEnv(fn) {
  const prev = {};
  for (const k of Object.keys(GRAPH_ENV)) { prev[k] = process.env[k]; process.env[k] = GRAPH_ENV[k]; }
  resetGraphToken();
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(GRAPH_ENV)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    resetGraphToken();
  });
}
// Routes the handler's outbound calls: the chat-lead Forms row, the pipeline-failures row, the Graph token and sendMail.
function router({ formsStatus = 200, mailStatus = 202 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const body = String(opts.body || '');
    calls.push({ url: u, body });
    if (u.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (u.includes('/sendMail')) return { ok: mailStatus < 300, status: mailStatus };
    if (body.includes('form-name=chat-lead')) return { ok: formsStatus < 300, status: formsStatus };
    return { ok: true, status: 200 }; // pipeline-failures row
  };
  return { calls, fetchImpl };
}
const leadFrom = (ip) => lead(ip, { 'x-nf-client-connection-ip': `192.0.2.${ip}` });

test('a stored chat lead sends no email of its own (Netlify\'s native chat-lead notification covers it)', () => withGraphEnv(async () => {
  const { calls, fetchImpl } = router();
  const r = await handler(leadFrom(10), { fetchImpl });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal(calls.filter((c) => c.url.includes('/sendMail')).length, 0);
}));

test('a failed Forms forward emails the lead to Gabriel and Eric, logs pipeline-failures, and still tells the visitor ok', () => withGraphEnv(async () => {
  const { calls, fetchImpl } = router({ formsStatus: 500 });
  const r = await handler(leadFrom(11), { fetchImpl });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  const mail = calls.find((c) => c.url.includes('/sendMail'));
  assert.ok(mail, 'the lead must be emailed when the Forms row could not be written');
  const msg = JSON.parse(mail.body).message;
  assert.deepEqual(msg.toRecipients.map((t) => t.emailAddress.address), ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net']);
  assert.match(msg.body.content, /l11@example\.com/);
  assert.match(msg.subject, /Chat Lead/);
  const failure = calls.find((c) => c.body.includes('form-name=pipeline-failures'));
  assert.ok(failure, 'the failed forward must leave a pipeline-failures row');
  assert.match(failure.body, /source-function=chat-lead/);
  assert.match(failure.body, /error-code=forms_forward_failed/);
}));

test('a thrown Forms forward is treated like a failed one', () => withGraphEnv(async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url); const body = String(opts.body || '');
    calls.push({ url: u, body });
    if (body.includes('form-name=chat-lead')) throw new Error('network down');
    if (u.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, status: 202 };
  };
  const r = await handler(leadFrom(12), { fetchImpl });
  assert.equal(r.statusCode, 200);
  assert.ok(calls.some((c) => c.url.includes('/sendMail')));
}));

test('a hung Forms endpoint (row AND failure log) still answers the visitor ok once the lead is emailed', () => withGraphEnv(async () => {
  const prev = { f: process.env.CHAT_LEAD_FORMS_TIMEOUT_MS, l: process.env.CHAT_LEAD_LOG_TIMEOUT_MS };
  process.env.CHAT_LEAD_FORMS_TIMEOUT_MS = '50';
  process.env.CHAT_LEAD_LOG_TIMEOUT_MS = '50';
  const never = () => new Promise(() => {});
  try {
    const calls = [];
    let rowSignal = null;
    const fetchImpl = (url, opts = {}) => {
      const u = String(url); const body = String(opts.body || '');
      calls.push({ url: u, body });
      if (body.includes('form-name=chat-lead')) {
        // Never answers on its own. Without an abort signal it stays pending forever, so a removed bound hangs
        // this test instead of passing it (2026-11-05 review: a throwing stub used to make it pass vacuously).
        rowSignal = opts.signal || null;
        if (!rowSignal) return never();
        return new Promise((resolve, reject) => { rowSignal.addEventListener('abort', () => reject(rowSignal.reason)); });
      }
      if (body.includes('form-name=pipeline-failures')) return never(); // the failure log hangs too
      if (u.includes('login.microsoftonline.com')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) });
      return Promise.resolve({ ok: true, status: 202 });
    };
    const t0 = Date.now();
    // A ref'd timer keeps the event loop alive: on Node 20 the handler's AbortSignal.timeout timer is unref'd, and a
    // stub that never settles holds no socket, so without it the test runner exits before the bound can fire
    // (CI, 2026-11-05: "Promise resolution is still pending but the event loop has already resolved").
    let guard;
    const hung = new Promise((resolve) => { guard = setTimeout(() => resolve('HUNG'), 2000); });
    const outcome = await Promise.race([handler(leadFrom(14), { fetchImpl }), hung]);
    clearTimeout(guard);
    assert.notEqual(outcome, 'HUNG', 'the handler must not wait on a hung Forms endpoint');
    assert.ok(rowSignal instanceof AbortSignal, 'the Forms row POST must carry an abort signal');
    assert.equal(outcome.statusCode, 200);
    assert.deepEqual(JSON.parse(outcome.body), { ok: true });
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(calls.some((c) => c.url.includes('/sendMail')), 'the lead must still be emailed');
  } finally {
    for (const [k, v] of [['CHAT_LEAD_FORMS_TIMEOUT_MS', prev.f], ['CHAT_LEAD_LOG_TIMEOUT_MS', prev.l]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}));

test('when the Forms forward AND the fallback email both fail, the visitor is told it did not go through', () => withGraphEnv(async () => {
  const { calls, fetchImpl } = router({ formsStatus: 503, mailStatus: 500 });
  const r = await handler(leadFrom(13), { fetchImpl });
  assert.equal(r.statusCode, 502);
  assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'unavailable' });
  // assets/chat.js shows "Could not submit. Please email ..." for any ok:false, so the visitor has a way through.
  assert.ok(calls.some((c) => c.body.includes('error-code=fallback_email_failed')));
}));

test('the limiter is checked before body parsing, so malformed spam cannot bypass it', async () => {
  const ip = { 'x-nf-client-connection-ip': '203.0.113.51' };
  for (let i = 0; i < 5; i++) await handler(lead(i, ip));
  const r = await handler({ httpMethod: 'POST', headers: ip, body: '{not json' });
  assert.equal(r.statusCode, 429);
});
