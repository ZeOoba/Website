'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../../netlify/functions/owner-lead-notify.js');
const { _resetCacheForTests } = require('../../netlify/functions/_shared/graph-auth.js');

// owner-lead-notify sends via _shared/graph-mail.js → _shared/graph-auth.js, so
// the Graph client-credential env must be present for the stubbed token flow to
// be reached (mirrors tenant-application-processor.test.js). GRAPH_SEND_FROM is
// required by sendMail() for the `from` mailbox.
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
  // The Graph token is cached module-level across calls; reset so each test's
  // login stub is actually exercised and tests stay order-independent.
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

// A well-formed owner-submission-intake payload.
const VALID_DATA = {
  'property-address': '1100 Rarig Avenue, Columbus, OH',
  'building-size-sf': '24,000',
  name: 'Jane Owner',
  phone: '555-123-4567',
  email: 'jane@example.com',
  'reason-for-selling': 'Retirement',
  timeline: '3-6 months',
  'occupancy-status': 'Owner-occupied',
  'asking-price-expectation': '$2.5M',
  'tcpa-consent': 'yes',
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
  const rawBody = JSON.stringify({ form_name: 'owner-submission-intake', id: 'sub-1', data: {} });
  const event = { headers: { 'x-webhook-signature': 'forged.forged.forged' }, body: rawBody };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push({ url: String(url), body: String(opts.body || '') }); return { ok: true, status: 200 }; };
  const res = await handler(event, { fetchImpl });
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

test('rejects a malformed-JSON body with a 400 and no email', () => withEnv(ENV, async () => {
  const rawBody = 'this is not json {';
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  const res = await handler(event, { fetchImpl: async (url) => { throw new Error(`must not call network: ${url}`); } });
  assert.equal(res.statusCode, 400);
}));

test('ignores submissions for other forms (no-op 200, no email)', () => withEnv(ENV, async () => {
  // This webhook fires for EVERY form on the site; a non-owner form must no-op.
  const rawBody = JSON.stringify({ form_name: 'contact', id: 'sub-2', data: { name: 'X' } });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  const res = await handler(event, { fetchImpl: async (url) => { throw new Error(`must not call network for a different form: ${url}`); } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).skipped, true);
}));

test('notifies BOTH ggoldberg and egoldberg on a valid owner-submission-intake submission', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'owner-submission-intake', id: 'sub-3', data: VALID_DATA });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };

  let sendMailBody = null;
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('sendMail')) { sendMailBody = String(opts.body || ''); return { ok: true, status: 202 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 200);
  assert.ok(calls.some((u) => u.includes('sendMail')), 'must send the notification email');
  assert.ok(sendMailBody, 'sendMail must be called with a body');
  const parsed = JSON.parse(sendMailBody);
  const recipients = parsed.message.toRecipients.map((r) => r.emailAddress.address);
  // Dual-notify is the whole point of this transactional lead-capture send
  // (distinct from the ggoldberg-only scheduled-automation routing canon).
  assert.deepEqual(recipients, ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net']);
  // Submitted lead detail must reach the mailbox.
  assert.ok(parsed.message.body.content.includes('1100 Rarig Avenue'), 'lead property address must appear in the email body');
}));

test('fails loudly (502, logged) when the notification email send fails', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'owner-submission-intake', id: 'sub-4', data: VALID_DATA });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };

  let loggedFailure = false;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('pipeline-failures')) { loggedFailure = true; return { ok: true, status: 200 }; }
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('sendMail')) return { ok: false, status: 502 }; // Graph rejects the send
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 502);
  assert.equal(loggedFailure, true, 'a failed send must be logged to the failure ledger, not silently dropped');
}));
