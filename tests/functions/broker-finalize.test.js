'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../../netlify/functions/broker-finalize.js');
const { signIntakeToken } = require('../../netlify/functions/_shared/validate.js');

// graph-auth.js (Task 2, committed) throws unless GRAPH_TENANT_ID/CLIENT_ID/
// CLIENT_SECRET are present — it checks them BEFORE the login fetch the stubs
// below intercept — and graph-mail.js throws unless GRAPH_SEND_FROM is set. The
// plan's draft env for this task listed only INTAKE_TOKEN_SECRET/GRAPH_DRIVE_ID/
// URL; the token-flow trio + GRAPH_SEND_FROM are added here so getItemByPath and
// sendMail actually run (identical omission + fix as Task 8/Task 9's tests).
const ENV = { INTAKE_TOKEN_SECRET: 'intake-secret', GRAPH_DRIVE_ID: 'drive-1', URL: 'https://oxfordra.net', GRAPH_SEND_FROM: 'no-reply@oxfordra.net', GRAPH_TENANT_ID: 'tenant-1', GRAPH_CLIENT_ID: 'client-1', GRAPH_CLIENT_SECRET: 'secret-1' };
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) process.env[k] = prev[k]; });
}

test('rejects a forged intake token', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: 'forged.forged', name: 'Bob', company: 'Acme', email: 'b@acme.com' }) };
  const res = await handler(event, { fetchImpl: async () => { throw new Error('must not call network'); } });
  assert.equal(res.statusCode, 401);
}));

test('rejects when the uploaded item is missing from the expected folder', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/2026-07-10_Acme_ab12/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: false, status: 404 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 409);
}));

test('finalizes a valid upload: forwards the ledger and sends both emails', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/2026-07-10_Acme_ab12/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com', phone: '555-1234', market: 'Columbus', message: 'See attached' }) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://contoso.sharepoint.com/x/om.pdf' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 }; // ledger forward
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 200);
  assert.ok(calls.some((u) => u.includes('sendMail')));
  assert.ok(calls.some((u) => u === 'https://oxfordra.net/'));
}));

test('rejects when the stored item size does not match the token-bound size', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/x/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 999, webUrl: 'https://x' }) }; // mismatched size
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 409);
}));
