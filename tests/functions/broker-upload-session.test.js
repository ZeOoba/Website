'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../../netlify/functions/broker-upload-session.js');

// graph-auth.js (Task 2, committed) throws unless GRAPH_TENANT_ID/CLIENT_ID/
// CLIENT_SECRET are present — it checks them BEFORE the login fetch the stubs
// below intercept. The plan's draft env for this task listed only GRAPH_DRIVE_ID
// + INTAKE_TOKEN_SECRET; the three token-flow vars are added here so the mocked
// createUploadSession path actually runs (identical omission + fix as Task 8's
// tenant-application-processor.test.js).
const ENV = { GRAPH_DRIVE_ID: 'drive-1', INTAKE_TOKEN_SECRET: 'intake-secret', GRAPH_TENANT_ID: 'tenant-1', GRAPH_CLIENT_ID: 'client-1', GRAPH_CLIENT_SECRET: 'secret-1', RECAPTCHA_SECRET_KEY: 'test-secret' };
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) process.env[k] = prev[k]; });
}

// Every test's fetchImpl must answer the recaptcha/api/siteverify call the
// handler now makes before any Graph/SharePoint work — this stub returns a
// passing verification so existing test scenarios exercise the same code
// paths they did before Task 13 added the gate.
function withRecaptchaPass(fetchImpl) {
  return async (url, opts) => {
    if (url.includes('recaptcha/api/siteverify')) return { ok: true, json: async () => ({ success: true }) };
    return fetchImpl(url, opts);
  };
}

test('rejects when the honeypot field is filled (silent 200, no session minted)', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'om.pdf', fileSize: 1000, contentType: 'application/pdf', website: 'spam' }) };
  const res = await handler(event, { fetchImpl: async () => { throw new Error('must not call Graph'); } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(JSON.parse(res.body).uploadUrl, undefined);
}));

test('rejects a disallowed file type', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'malware.exe', fileSize: 1000, contentType: 'application/octet-stream', recaptchaToken: 'good-token' }) };
  const res = await handler(event, { fetchImpl: withRecaptchaPass(async (url) => { throw new Error(`must not call Graph: ${url}`); }) });
  assert.equal(res.statusCode, 422);
}));

test('rejects a file over the 60 MB ceiling', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'om.pdf', fileSize: 61 * 1024 * 1024, contentType: 'application/pdf', recaptchaToken: 'good-token' }) };
  const res = await handler(event, { fetchImpl: withRecaptchaPass(async (url) => { throw new Error(`must not call Graph: ${url}`); }) });
  assert.equal(res.statusCode, 413);
}));

test('rejects with recaptcha_failed when the token does not verify', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'bad-token' }) };
  const fetchImpl = async (url) => {
    if (url.includes('recaptcha/api/siteverify')) return { ok: true, json: async () => ({ success: false }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
}));

test('fails closed with recaptcha_failed (not a 500) when verifyRecaptcha throws — e.g. a network-level failure calling siteverify', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'good-token' }) };
  const fetchImpl = async (url) => {
    if (url.includes('recaptcha/api/siteverify')) throw new Error('ECONNRESET');
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'recaptcha_failed');
}));

test('fails closed with recaptcha_failed when verifyRecaptcha throws due to missing RECAPTCHA_SECRET_KEY', () => withEnv({ ...ENV, RECAPTCHA_SECRET_KEY: '' }, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'good-token' }) };
  const res = await handler(event, { fetchImpl: async (url) => { throw new Error(`must not call network: ${url}`); } });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'recaptcha_failed');
}));

test('mints a session and a verifiable intake token for a valid request, logging intake first', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', market: 'Columbus', message: 'hi', fileName: 'om.pdf', fileSize: 30_000_000, contentType: 'application/pdf', recaptchaToken: 'good-token' }) };
  let loggedIntake = null;
  const fetchImpl = withRecaptchaPass(async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('broker-submission-intake')) { loggedIntake = opts.body; return { ok: true, status: 200 }; }
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes(':/createUploadSession')) return { ok: true, status: 200, json: async () => ({ uploadUrl: 'https://contoso.sharepoint.com/upload/s1', expirationDateTime: '2026-07-11T00:00:00Z' }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.uploadUrl, 'https://contoso.sharepoint.com/upload/s1');
  assert.ok(parsed.intakeToken.split('.').length === 2, 'intakeToken must be payload.signature');
  assert.ok(loggedIntake, 'a broker-submission-intake row must be logged for every validated attempt');
  assert.ok(loggedIntake.includes('company=Acme'), 'intake row must carry the contact/deal fields');
}));

test('logs the submission intake even when minting the Graph upload session fails', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'om.pdf', fileSize: 1000, contentType: 'application/pdf', recaptchaToken: 'good-token' }) };
  let loggedIntake = false;
  let loggedFailure = false;
  const fetchImpl = withRecaptchaPass(async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('broker-submission-intake')) { loggedIntake = true; return { ok: true, status: 200 }; }
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('pipeline-failures')) { loggedFailure = true; return { ok: true, status: 200 }; }
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes(':/createUploadSession')) return { ok: false, status: 503 };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'session_failed');
  assert.ok(loggedIntake, 'contact/deal context must be preserved even when Graph itself fails — this is the exact gap being closed');
  assert.ok(loggedFailure, 'the failure itself must still be logged to pipeline-failures too');
}));
