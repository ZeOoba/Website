'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../../netlify/functions/contact-notify.js');
const { _resetCacheForTests } = require('../../netlify/functions/_shared/graph-auth.js');

// contact-notify sends via _shared/graph-mail.js → _shared/graph-auth.js, so the
// Graph client-credential env must be present for the stubbed token flow to be
// reached (mirrors owner-lead-notify.test.js).
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

const VALID_DATA = {
  name: 'Jane Broker',
  email: 'jane@example.com',
  phone: '555-123-4567',
  subject: 'Acquisition Opportunity',
  message: 'We have an off-market 22,000 SF flex building in Columbia, MD.',
  'bot-field': '',
  'form-name': 'contact',
  'g-recaptcha-response': 'token-that-must-not-leak-into-the-email',
};

// A forged signature must make ZERO network calls: a pipeline-failures Forms
// row here would re-fire every submission-created webhook (feedback loop on a
// rotated secret) and let unauthenticated POSTs burn the Forms quota.
test('rejects a submission with an invalid webhook signature (401, no network call)', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'contact', id: 'sub-1', data: {} });
  const event = { headers: { 'x-webhook-signature': 'forged.forged.forged' }, body: rawBody };
  const fetchImpl = async (url) => { throw new Error(`must not call network: ${url}`); };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 401);
}));

test('rejects a malformed-JSON body with a 400 and no email', () => withEnv(ENV, async () => {
  const rawBody = 'this is not json {';
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  const res = await handler(event, { fetchImpl: async (url) => { throw new Error(`must not call network: ${url}`); } });
  assert.equal(res.statusCode, 400);
}));

test('ignores submissions for other forms (no-op 200, no email)', () => withEnv(ENV, async () => {
  // This webhook fires for EVERY form on the site; a non-contact form must no-op.
  const rawBody = JSON.stringify({ form_name: 'owner-submission-intake', id: 'sub-2', data: { name: 'X' } });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  const res = await handler(event, { fetchImpl: async (url) => { throw new Error(`must not call network for a different form: ${url}`); } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).skipped, true);
}));

test('notifies BOTH ggoldberg and egoldberg on a valid contact submission, without form plumbing fields', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'contact', id: 'sub-3', data: VALID_DATA });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };

  let sendMailBody = null;
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('sendMail')) { sendMailBody = String(opts.body || ''); return { ok: true, status: 202 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 200);
  assert.ok(sendMailBody, 'sendMail must be called with a body');
  const parsed = JSON.parse(sendMailBody);
  const recipients = parsed.message.toRecipients.map((r) => r.emailAddress.address);
  // Dual-notify: this is transactional lead capture, distinct from the
  // ggoldberg-only scheduled-automation routing canon. "Acquisition Opportunity"
  // is a subject option, so this form can carry deal flow.
  assert.deepEqual(recipients, ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net']);
  assert.ok(parsed.message.subject.includes('Acquisition Opportunity') && parsed.message.subject.includes('Jane Broker'), 'subject line must carry the topic and sender');
  assert.ok(parsed.message.body.content.includes('off-market 22,000 SF'), 'the message text must reach the mailbox');
  assert.ok(!parsed.message.body.content.includes('token-that-must-not-leak'), 'the reCAPTCHA token is form plumbing, not lead content');
  assert.ok(!/bot-field|form-name/.test(parsed.message.body.content), 'honeypot and form-name are form plumbing, not lead content');
}));

test('escapes HTML in submitted fields (a contact form is public, unauthenticated input)', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'contact', id: 'sub-5', data: { ...VALID_DATA, message: '<script>alert(1)</script>' } });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  let html = '';
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('sendMail')) { html = JSON.parse(String(opts.body)).message.body.content; return { ok: true, status: 202 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 200);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw markup from the form must never reach the email HTML');
}));

test('fails loudly (502, logged) when the notification email send fails', () => withEnv(ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'contact', id: 'sub-4', data: VALID_DATA });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };

  let loggedFailure = false;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('pipeline-failures')) { loggedFailure = true; return { ok: true, status: 200 }; }
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('sendMail')) return { ok: false, status: 502 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 502);
  assert.equal(loggedFailure, true, 'a failed send must be logged to the failure ledger, not silently dropped');
}));
