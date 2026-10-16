'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../../netlify/functions/checklist-notify.js');
const { _resetCacheForTests } = require('../../netlify/functions/_shared/graph-auth.js');

const ENV = {
  NETLIFY_WEBHOOK_SECRET: 'shh',
  GRAPH_SEND_FROM: 'no-reply@oxfordra.net',
  GRAPH_TENANT_ID: 'tenant-1',
  GRAPH_CLIENT_ID: 'client-1',
  GRAPH_CLIENT_SECRET: 'secret-1',
};

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  _resetCacheForTests();
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) process.env[k] = prev[k]; });
}

function signBody(rawBody, secret) {
  const crypto = require('node:crypto');
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ iss: 'netlify', sha256: crypto.createHash('sha256').update(rawBody).digest('hex') });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const graphOk = (onSend) => async (url, opts = {}) => {
  if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  if (url.includes('sendMail')) { onSend && onSend(String(opts.body || '')); return { ok: true, status: 202 }; }
  throw new Error(`unexpected fetch: ${url}`);
};

// A forged signature must never write a Netlify Forms row (it would re-fire every submission-created webhook:
// feedback loop on a rotated secret + Forms-quota burn), and the ONLY outbound request allowed is the signed
// call to the V2 signature-alert function, which owns the global once-per-hour guard. Calls are RECORDED, not
// thrown on: forwardToNetlifyForm swallows a throwing fetchImpl. A missing/malformed header (a scanner) makes none.
const { _resetForTests: resetAlert } = require('../../netlify/functions/_shared/signature-alert.js');
const ALERT_URL = 'https://oxfordra.net/.netlify/functions/signature-alert';
const ALERT_ENV = { ...ENV, INTAKE_TOKEN_SECRET: 'intake-secret' };

test('a JWS-shaped bad signature is a 401 whose only outbound request is the signed call to the V2 alert function', () => withEnv(ALERT_ENV, async () => {
  resetAlert();
  const rawBody = JSON.stringify({ form_name: 'checklist-download', id: 'c-1', data: {} });
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push({ url: String(url), body: String(opts.body || '') }); return { ok: true, status: 200 }; };
  const res = await handler({ headers: { 'x-webhook-signature': 'forged.forged.forged' }, body: rawBody }, { fetchImpl });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(calls.map((c) => c.url), [ALERT_URL], 'exactly one request, to the alert function; never Forms, never Graph directly');
  assert.ok(JSON.parse(calls[0].body).token, 'the call carries a signed token');
}));

test('an UNSET NETLIFY_WEBHOOK_SECRET is high confidence: even with no header the bad request makes the one signed alert call', () => withEnv({ ...ALERT_ENV, NETLIFY_WEBHOOK_SECRET: '' }, async () => {
  resetAlert();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return { ok: true, status: 200 }; };
  const res = await handler({ headers: {}, body: '{}' }, { fetchImpl });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(calls, [ALERT_URL]);
}));

test('a missing signature header (a scanner) is a 401 with no network call at all', () => withEnv(ALERT_ENV, async () => {
  resetAlert();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return { ok: true, status: 200 }; };
  const res = await handler({ headers: {}, body: '{}' }, { fetchImpl });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(calls, []);
}));

test('ignores every other form (no-op 200, no email)', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'contact', id: 'c-2', data: { name: 'X' } });
  const res = await handler({ headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody }, { fetchImpl: async (url) => { throw new Error(`must not call network: ${url}`); } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).skipped, true);
}));

test('notifies Gabriel only (a checklist download is a low-intent lead), with name and email', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'checklist-download', id: 'c-3', data: { name: 'Jane Owner', email: 'jane@example.com', 'bot-field': '', 'form-name': 'checklist-download' } });
  let sent = null;
  const res = await handler({ headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody }, { fetchImpl: graphOk((b) => { sent = JSON.parse(b); }) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sent.message.toRecipients.map((r) => r.emailAddress.address), ['ggoldberg@oxfordra.net']);
  assert.ok(sent.message.subject.includes('Jane Owner'));
  assert.ok(sent.message.body.content.includes('jane@example.com'));
}));

test('escapes HTML in the submitted name (public unauthenticated input)', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'checklist-download', id: 'c-4', data: { name: '<img src=x onerror=alert(1)>', email: 'a@b.co' } });
  let html = '';
  const res = await handler({ headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody }, { fetchImpl: graphOk((b) => { html = JSON.parse(b).message.body.content; }) });
  assert.equal(res.statusCode, 200);
  assert.ok(!html.includes('<img src=x'), 'raw markup must never reach the email HTML');
}));

test('fails loudly (502, logged) when the send fails', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'checklist-download', id: 'c-5', data: { name: 'Jane', email: 'j@e.co' } });
  let logged = false;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('pipeline-failures')) { logged = true; return { ok: true, status: 200 }; }
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('sendMail')) return { ok: false, status: 502 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler({ headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody }, { fetchImpl });
  assert.equal(res.statusCode, 502);
  assert.equal(logged, true);
}));
