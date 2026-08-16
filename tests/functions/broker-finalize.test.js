'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { signIntakeToken } = require('../../netlify/functions/_shared/validate.js');

// broker-finalize migrated to the Netlify V2 signature (ESM, Request in /
// Response out) on 2026-08-16, because a `handler` export marks a function as
// legacy V1 and Blobs auto-provisioning does not cover V1.
//
// This adapter deliberately keeps the V1-shaped `event` literals and the
// {statusCode, body} assertions below byte-identical: the transport changed,
// the behavioural contract these tests pin did not, and rewriting both at once
// would have destroyed the evidence that nothing else moved.
let finalizeModulePromise;
function loadFinalize() {
  finalizeModulePromise ||= import(
    pathToFileURL(path.join(__dirname, '..', '..', 'netlify', 'functions', 'broker-finalize.mjs')).href
  );
  return finalizeModulePromise;
}

async function callFinalize(event, deps) {
  const { handleBrokerFinalize } = await loadFinalize();
  const req = new Request('https://oxfordra.net/api/broker-finalize', {
    method: event.httpMethod || 'GET',
    headers: event.headers || {},
    ...(event.body === undefined ? {} : { body: event.body }),
  });
  const res = await handleBrokerFinalize(req, deps);
  return { statusCode: res.status, body: await res.text() };
}

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
  const res = await callFinalize(event, { fetchImpl: async () => { throw new Error('must not call network'); } });
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
  const res = await callFinalize(event, { fetchImpl });
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
  const res = await callFinalize(event, { fetchImpl });
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
  const res = await callFinalize(event, { fetchImpl });
  assert.equal(res.statusCode, 409);
}));

// Fake overrides for the rate-limit/daily-cap backstop (broker-score-store.js)
// so tests don't hit real Netlify Blobs (unavailable outside the Netlify
// runtime — would throw MissingBlobsEnvironmentError).
const allowAll = {
  checkAndRecordRateLimitImpl: async () => ({ allowed: true }),
  checkAndRecordDailyCapImpl: async () => ({ allowed: true }),
};

test('finalize triggers background scoring and returns a submissionId', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/2026-07-18_Acme_ab12/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com', phone: '555-1234', market: 'Columbus', message: 'See attached' }) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://contoso.sharepoint.com/x/om.pdf' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url.includes('/.netlify/functions/broker-score-background')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, { fetchImpl, ...allowAll });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(typeof body.submissionId, 'string');
  assert.ok(body.submissionId.length > 0);
  assert.ok(calls.some((u) => u.includes('/.netlify/functions/broker-score-background')));
}));

test('finalize still succeeds even if triggering the background scorer fails outright', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/2026-07-18_Acme_cd34/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url.includes('/.netlify/functions/broker-score-background')) throw new Error('network down');
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, { fetchImpl, ...allowAll });
  assert.equal(res.statusCode, 200); // core submission still succeeds
}));

test('skips triggering background scoring when the daily cap is reached, but still returns ok+submissionId', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/2026-07-18_Acme_ef56/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, {
    fetchImpl,
    checkAndRecordRateLimitImpl: async () => ({ allowed: true }),
    checkAndRecordDailyCapImpl: async () => ({ allowed: false }),
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.submissionId, 'string');
  assert.ok(body.submissionId.length > 0);
  assert.ok(!calls.some((u) => u.includes('/.netlify/functions/broker-score-background')), 'trigger must not fire once the daily cap is reached');
}));

test('skips triggering background scoring when the per-IP rate limit is reached, but still returns ok+submissionId', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/2026-07-18_Acme_gh78/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const calls = [];
  let seenIp = null;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, {
    fetchImpl,
    checkAndRecordRateLimitImpl: async (ip) => { seenIp = ip; return { allowed: false }; },
    checkAndRecordDailyCapImpl: async () => ({ allowed: true }),
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(seenIp, '1.2.3.4', 'IP must be extracted from x-forwarded-for and passed to the rate limiter');
  assert.ok(!calls.some((u) => u.includes('/.netlify/functions/broker-score-background')), 'trigger must not fire once the rate limit is reached');
}));

// Griefing-quota regression: a single IP that has already exhausted its own
// per-IP rate limit must NOT be able to keep spending slots of the shared
// global daily cap by repeatedly POSTing. checkAndRecordDailyCapImpl must
// never even be invoked once the rate limit has already disallowed the
// request — that's the fix (sequential + gated, not Promise.all).
test('never calls checkAndRecordDailyCapImpl when the per-IP rate limit already disallows (griefing-quota regression)', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ path: 'Broker Submissions/2026-07-18_Acme_ij90/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  let dailyCapCallCount = 0;
  const res = await callFinalize(event, {
    fetchImpl,
    checkAndRecordRateLimitImpl: async () => ({ allowed: false }),
    checkAndRecordDailyCapImpl: async () => { dailyCapCallCount += 1; return { allowed: true }; },
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(dailyCapCallCount, 0, 'a rate-limited IP must never consume a slot of the shared daily cap');
}));
