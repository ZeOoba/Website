'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../../netlify/functions/tenant-application-processor.js');

// graph-auth.js (Task 2, committed) requires GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET
// to be set before it will even attempt the token fetch — the tests below stub
// login.microsoftonline.com, so these three must be present for that stub to be
// reached (omitted from the plan's draft env; added here so the token flow runs).
const FILE_ALLOWLIST_ENV = { NETLIFY_WEBHOOK_SECRET: 'shh', ALERT_TO: 'ggoldberg@oxfordra.net', GRAPH_DRIVE_ID: 'drive-1', GRAPH_SEND_FROM: 'no-reply@oxfordra.net', GRAPH_TENANT_ID: 'tenant-1', GRAPH_CLIENT_ID: 'client-1', GRAPH_CLIENT_SECRET: 'secret-1' };

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
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

// A forged signature must never write a Netlify Forms row (it would re-fire every submission-created webhook:
// feedback loop on a rotated secret + Forms-quota burn), and the ONLY outbound request allowed is the signed
// call to the V2 signature-alert function, which owns the global once-per-hour guard. Calls are RECORDED, not
// thrown on: forwardToNetlifyForm swallows a throwing fetchImpl. A missing/malformed header (a scanner) makes none.
const { _resetForTests: resetAlert } = require('../../netlify/functions/_shared/signature-alert.js');
const ALERT_URL = 'https://oxfordra.net/.netlify/functions/signature-alert';
const ALERT_ENV = { ...FILE_ALLOWLIST_ENV, INTAKE_TOKEN_SECRET: 'intake-secret' };

test('a JWS-shaped bad signature is a 401 whose only outbound request is the signed call to the V2 alert function', () => withEnv(ALERT_ENV, async () => {
  resetAlert();
  const rawBody = JSON.stringify({ form_name: 'commercial-lease-application', id: 'sub-1', data: {} });
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

test('ignores submissions for other forms (no-op 200, no Graph calls)', () => withEnv(FILE_ALLOWLIST_ENV, async () => {
  const rawBody = JSON.stringify({ form_name: 'contact', id: 'sub-2', data: {} });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  const res = await handler(event, { fetchImpl: async () => { throw new Error('must not call network for a different form'); } });
  assert.equal(res.statusCode, 200);
}));

test('processes a valid commercial-lease-application submission end-to-end', () => withEnv(FILE_ALLOWLIST_ENV, async () => {
  // Netlify Forms serializes file-upload fields as objects — {filename, type,
  // size, url} — not bare URL strings. Confirmed against a real fired webhook
  // via the Submissions API (2026-07-12); a bare string here would mask the
  // production filing_failed bug this fixture exists to catch.
  const data = {
    'applicant-email': 'jane@example.com', 'full-legal-name': 'Jane Doe', 'building-unit': '1100 Rarig Avenue, Columbus, OH',
    'upload-credit-report': { filename: 'credit.pdf', type: 'file', size: 111, url: 'https://oxfordra.net/uploads/credit.pdf' },
    'upload-drivers-license': { filename: 'dl.pdf', type: 'file', size: 222, url: 'https://oxfordra.net/uploads/dl.pdf' },
    'upload-articles': { filename: 'articles.pdf', type: 'file', size: 333, url: 'https://oxfordra.net/uploads/articles.pdf' },
  };
  const rawBody = JSON.stringify({ form_name: 'commercial-lease-application', id: 'sub-3', data });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };

  const fileBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF- magic bytes for all three
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.startsWith('https://oxfordra.net/uploads/')) return { ok: true, status: 200, arrayBuffer: async () => fileBytes };
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/') && !url.includes(':/content') && !url.includes('children')) return { ok: false, status: 404 }; // folder doesn't exist yet
    if (url.endsWith(':/children') || (opts.method === 'POST' && url.includes('root/children'))) return { ok: true, status: 201, json: async () => ({ id: 'folder' }) };
    if (url.endsWith(':/content')) return { ok: true, status: 200, json: async () => ({ webUrl: 'https://contoso.sharepoint.com/x/f.pdf', id: 'i' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 }; // not used here, but harmless if hit
    throw new Error(`unexpected fetch: ${url}`);
  };

  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 200);
  assert.ok(calls.some((u) => u.includes('sendMail')), 'must send the notification email');
}));

test('rejects an upload whose bytes do not match its declared extension', () => withEnv(FILE_ALLOWLIST_ENV, async () => {
  const data = {
    'full-legal-name': 'Jane Doe',
    'upload-credit-report': { filename: 'credit.pdf', type: 'file', size: 111, url: 'https://oxfordra.net/uploads/credit.pdf' },
    'upload-drivers-license': { filename: 'dl.pdf', type: 'file', size: 222, url: 'https://oxfordra.net/uploads/dl.pdf' },
    'upload-articles': { filename: 'articles.pdf', type: 'file', size: 333, url: 'https://oxfordra.net/uploads/articles.pdf' },
  };
  const rawBody = JSON.stringify({ form_name: 'commercial-lease-application', id: 'sub-4', data });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  const exeBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  let sentMail = false;
  const fetchImpl = async (url) => {
    if (url.startsWith('https://oxfordra.net/uploads/')) return { ok: true, status: 200, arrayBuffer: async () => exeBytes };
    if (url.includes('sendMail')) { sentMail = true; return { ok: true, status: 202 }; }
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 422);
  assert.equal(sentMail, false, 'must not email a link to a rejected file');
}));

test('fails loudly (logged, 502) on a present-but-malformed upload object, never a silent 200', () => withEnv(FILE_ALLOWLIST_ENV, async () => {
  const data = {
    'full-legal-name': 'Jane Doe',
    // filename/type/size present but url missing — the object is truthy, so a
    // bare `if (!upload) continue;` guard would silently skip this file and
    // return 200 with the document missing, defeating this pipeline's
    // explicit no-silent-failure design (see the comment above the try block).
    'upload-credit-report': { filename: 'credit.pdf', type: 'file', size: 111 },
    'upload-drivers-license': { filename: 'dl.pdf', type: 'file', size: 222, url: 'https://oxfordra.net/uploads/dl.pdf' },
    'upload-articles': { filename: 'articles.pdf', type: 'file', size: 333, url: 'https://oxfordra.net/uploads/articles.pdf' },
  };
  const rawBody = JSON.stringify({ form_name: 'commercial-lease-application', id: 'sub-5', data });
  const event = { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
  let loggedFailure = false;
  let sentMail = false;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('pipeline-failures')) { loggedFailure = true; return { ok: true, status: 200 }; }
    if (url.includes('sendMail')) { sentMail = true; return { ok: true, status: 202 }; }
    if (url.startsWith('https://oxfordra.net/uploads/')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from([0x25, 0x50, 0x44, 0x46]) };
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 502);
  assert.equal(loggedFailure, true, 'a malformed upload must be logged to the failure ledger, not silently dropped');
  assert.equal(sentMail, false, 'must not email a link when a document silently failed to file');
}));
