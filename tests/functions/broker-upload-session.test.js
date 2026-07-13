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
const ENV = { GRAPH_DRIVE_ID: 'drive-1', INTAKE_TOKEN_SECRET: 'intake-secret', GRAPH_TENANT_ID: 'tenant-1', GRAPH_CLIENT_ID: 'client-1', GRAPH_CLIENT_SECRET: 'secret-1' };
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) process.env[k] = prev[k]; });
}

// Mirrors netlify/functions/_shared/rate-limit.js's own SQL shape (see its
// fake in tests/functions/_shared/rate-limit.test.js) — an in-memory table
// keyed by rate-limit key, standing in for a Postgres connection.
function fakeGetClient() {
  const table = new Map();
  return async () => ({
    query: async (text, params) => {
      if (text.startsWith('CREATE TABLE')) return [];
      if (text.startsWith('SELECT')) {
        const row = table.get(params[0]);
        return row ? [row] : [];
      }
      if (text.startsWith('INSERT')) {
        table.set(params[0], { window_start: params[1], count: 1 });
        return [];
      }
      if (text.startsWith('UPDATE')) {
        const row = table.get(params[0]);
        row.count += 1;
        return [];
      }
      throw new Error(`fakeGetClient: unexpected statement: ${text}`);
    },
    end: async () => {},
  });
}

test('rejects when the honeypot field is filled (silent 200, no session minted)', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'om.pdf', fileSize: 1000, contentType: 'application/pdf', website: 'spam' }) };
  const res = await handler(event, { fetchImpl: async () => { throw new Error('must not call Graph'); }, getClient: fakeGetClient() });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(JSON.parse(res.body).uploadUrl, undefined);
}));

test('rejects a disallowed file type', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'malware.exe', fileSize: 1000, contentType: 'application/octet-stream' }) };
  const res = await handler(event, { fetchImpl: async () => { throw new Error('must not call Graph'); }, getClient: fakeGetClient() });
  assert.equal(res.statusCode, 422);
}));

test('rejects a file over the 60 MB ceiling', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'om.pdf', fileSize: 61 * 1024 * 1024, contentType: 'application/pdf' }) };
  const res = await handler(event, { fetchImpl: async () => { throw new Error('must not call Graph'); }, getClient: fakeGetClient() });
  assert.equal(res.statusCode, 413);
}));

test('mints a session and a verifiable intake token for a valid request', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', market: 'Columbus', message: 'hi', fileName: 'om.pdf', fileSize: 30_000_000, contentType: 'application/pdf' }) };
  const fetchImpl = async (url, opts) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes(':/createUploadSession')) return { ok: true, status: 200, json: async () => ({ uploadUrl: 'https://contoso.sharepoint.com/upload/s1', expirationDateTime: '2026-07-11T00:00:00Z' }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl, getClient: fakeGetClient() });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.uploadUrl, 'https://contoso.sharepoint.com/upload/s1');
  assert.ok(parsed.intakeToken.split('.').length === 2, 'intakeToken must be payload.signature');
}));

test('fails loudly (logged, 502) when the rate-limit check throws, never an uncaught crash', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'om.pdf', fileSize: 1000, contentType: 'application/pdf' }) };
  const getClient = async () => { throw new Error('connection refused'); };
  let loggedFailure = false;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('pipeline-failures')) { loggedFailure = true; return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl, getClient });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'rate_limit_check_failed');
  assert.equal(loggedFailure, true, 'a rate-limit-check crash must be logged to the failure ledger, not silently dropped');
}));

test('rate-limits after repeated requests from the same IP', () => withEnv(ENV, async () => {
  const getClient = fakeGetClient();
  const makeEvent = () => ({ httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ name: 'Bob', company: 'Acme', email: 'b@acme.com', fileName: 'om.pdf', fileSize: 1000, contentType: 'application/pdf' }) });
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, status: 200, json: async () => ({ uploadUrl: 'https://x/y', expirationDateTime: 'z' }) };
  };
  let last;
  for (let i = 0; i < 12; i += 1) last = await handler(makeEvent(), { fetchImpl, getClient });
  assert.equal(last.statusCode, 429);
}));
