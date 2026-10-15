'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { signIntakeToken, verifyIntakeToken } = require('../../netlify/functions/_shared/validate.js');

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
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-07-10_Acme_ab12/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-07-10_Acme_ab12/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/x/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 999, webUrl: 'https://x' }) }; // mismatched size
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, { fetchImpl });
  assert.equal(res.statusCode, 409);
}));

// Quota burn (adversarial review of PR #162, C2): the upload_not_found and
// size_mismatch branches run BEFORE the token is consumed, so one valid intake
// token (15-min TTL) whose upload is missing or the wrong size could be replayed
// without limit, and every replay wrote a pipeline-failures Forms row that then
// re-fired every submission-created webhook. These branches must stay on the
// deploy log only. Calls are RECORDED rather than thrown on: forwardToNetlifyForm
// swallows a throwing fetchImpl, so a throw alone cannot fail the old behaviour.
function formsPosts(calls) { return calls.filter((c) => c.url === 'https://oxfordra.net/'); }

test('replaying a token whose upload is missing never writes a Forms row (quota burn)', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/x/missing.pdf', size: 1000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob', company: 'Acme', email: 'b@acme.com' }) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, body: String(opts.body || '') });
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: false, status: 404 };
    return { ok: true, status: 200 };
  };
  for (let i = 0; i < 5; i += 1) {
    const res = await callFinalize(event, { fetchImpl });
    assert.equal(res.statusCode, 409, `replay ${i + 1} must still be rejected with 409`);
    assert.equal(JSON.parse(res.body).error, 'upload_not_found');
  }
  assert.deepEqual(formsPosts(calls), [], 'five replays of a missing-upload token must not write any Forms row');
}));

test('replaying a token whose stored size mismatches never writes a Forms row (quota burn)', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/x/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob', company: 'Acme', email: 'b@acme.com' }) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, body: String(opts.body || '') });
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 999, webUrl: 'https://x' }) };
    return { ok: true, status: 200 };
  };
  for (let i = 0; i < 5; i += 1) {
    const res = await callFinalize(event, { fetchImpl });
    assert.equal(res.statusCode, 409, `replay ${i + 1} must still be rejected with 409`);
    assert.equal(JSON.parse(res.body).error, 'size_mismatch');
  }
  assert.deepEqual(formsPosts(calls), [], 'five replays of a size-mismatched token must not write any Forms row');
}));

// A verified intake token was replayable for its whole 15-minute TTL: each
// replay wrote another ledger row and sent another pair of emails to Gabriel and
// Eric off a single reCAPTCHA solve (2026-09-25 audit). The token is now
// consumed once the upload is validated; a second finalize is a 409.
test('a replayed intake token is rejected with 409 and sends nothing a second time', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re01/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  let mails = 0;
  let ledgerRows = 0;
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) { mails += 1; return { ok: true, status: 202 }; }
    if (url === 'https://oxfordra.net/') { ledgerRows += 1; return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const consumed = new Set();
  const consumeIntakeTokenImpl = async (key) => { const first = !consumed.has(key); consumed.add(key); return { first }; };
  const deps = { fetchImpl, consumeIntakeTokenImpl, checkAndRecordRateLimitImpl: async () => ({ allowed: false }), checkAndRecordDailyCapImpl: async () => ({ allowed: true }) };

  const first = await callFinalize(event, deps);
  assert.equal(first.statusCode, 200);
  assert.equal(mails, 1);
  assert.equal(ledgerRows, 1);

  const replay = await callFinalize(event, deps);
  assert.equal(replay.statusCode, 409);
  assert.equal(JSON.parse(replay.body).error, 'intake_token_replayed');
  assert.equal(mails, 1, 'replay must not send another email');
  assert.equal(ledgerRows, 1, 'replay must not write another ledger row');
}));

test('an email failure after the token is consumed releases it, so the broker retry succeeds and sends one email', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re03/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  let mailAttempts = 0;
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) { mailAttempts += 1; return mailAttempts === 1 ? { ok: false, status: 503, text: async () => 'throttled' } : { ok: true, status: 202 }; }
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const consumed = new Set();
  const deps = {
    fetchImpl,
    consumeIntakeTokenImpl: async (key) => { const first = !consumed.has(key); consumed.add(key); return { first }; },
    releaseIntakeTokenImpl: async (key) => { consumed.delete(key); },
    checkAndRecordRateLimitImpl: async () => ({ allowed: false }),
    checkAndRecordDailyCapImpl: async () => ({ allowed: true }),
  };
  const first = await callFinalize(event, deps);
  assert.equal(first.statusCode, 502);
  assert.equal(JSON.parse(first.body).error, 'email_failed');

  const retry = await callFinalize(event, deps);
  assert.equal(retry.statusCode, 200, 'retry after a transient email failure must not be treated as a replay');
  assert.equal(mailAttempts, 2);
}));

test('a consume-store outage fails open with a logged pipeline-failures row rather than blocking the broker', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re02/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const failureRows = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') { if (String(opts.body || '').includes('pipeline-failures')) failureRows.push(String(opts.body)); return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, { fetchImpl, consumeIntakeTokenImpl: async () => { throw new Error('blobs down'); }, checkAndRecordRateLimitImpl: async () => ({ allowed: false }), checkAndRecordDailyCapImpl: async () => ({ allowed: true }) });
  assert.equal(res.statusCode, 200);
  assert.ok(failureRows.some((r) => r.includes('intake_consume_unavailable')), 'the outage must be visible in pipeline-failures');
}));

// The Blobs client retries 429/5xx for ~25 s, longer than the synchronous function limit, so a hung
// consume would get the function killed before the catch could fail open and log. The consume is
// bounded: a consume that never answers takes the same fail-open-and-log path as one that throws.
test('a consume that hangs is bounded: fails open and logs intake_consume_unavailable instead of hanging', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re03/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const failureRows = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') { if (String(opts.body || '').includes('pipeline-failures')) failureRows.push(String(opts.body)); return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const started = Date.now();
  const res = await callFinalize(event, { fetchImpl, consumeTimeoutMs: 40, consumeIntakeTokenImpl: () => new Promise(() => {}), checkAndRecordRateLimitImpl: async () => ({ allowed: false }), checkAndRecordDailyCapImpl: async () => ({ allowed: true }) });
  assert.equal(res.statusCode, 200, 'a hung consume must fail open, like an outage');
  assert.ok(Date.now() - started < 3000, 'the hung consume must be cut off by the timeout, not waited out');
  const row = failureRows.find((r) => r.includes('intake_consume_unavailable'));
  assert.ok(row, 'the timeout must be visible in pipeline-failures');
  assert.match(decodeURIComponent(row.replace(/\+/g, ' ')), /timed out after 40 ms/);
}));

// Round-3 review of PR #167: the bound must sit ABOVE the Blobs client's first retry backoff (~5 s), or any
// single transient 5xx/429 always fails open and skips replay protection; and it must stay under the
// synchronous function limit (10 s default).
test('the consume timeout sits above the client first-retry backoff and under the 10 s function limit', async () => {
  const { CONSUME_TIMEOUT_MS } = await loadFinalize();
  assert.ok(CONSUME_TIMEOUT_MS >= 6000, `CONSUME_TIMEOUT_MS=${CONSUME_TIMEOUT_MS} must exceed the ~5 s first retry backoff`);
  // Must leave room in the ~9 s request budget for the lookup, ledger, mail and the backstops: 9900 would pass a
  // '< 10 s' check yet leave nothing (round-4 review mutant).
  assert.ok(CONSUME_TIMEOUT_MS <= 7000, `CONSUME_TIMEOUT_MS=${CONSUME_TIMEOUT_MS} must leave room in the request budget`);
});

// Round-4 review of PR #167: the daily-cap call was bounded in code but no test pinned it; the backstops now
// also share what is left of a request budget instead of each taking a fixed allowance.
test('a hung daily-cap backstop is bounded: the broker still gets ok, scoring is skipped', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re06/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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
  const started = Date.now();
  const res = await callFinalize(event, { fetchImpl, consumeIntakeTokenImpl: async () => ({ first: true }), checkAndRecordRateLimitImpl: async () => ({ allowed: true }), checkAndRecordDailyCapImpl: () => new Promise(() => {}) });
  assert.equal(res.statusCode, 200);
  assert.ok(Date.now() - started < 6000, 'the hung daily-cap call must be cut off by its bound');
  assert.ok(!calls.some((u) => u.includes('broker-score-background')), 'scoring must be skipped when the daily cap cannot answer');
}));

test('once the request budget is spent the scoring backstops are skipped without being called', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re07/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  let rateCalls = 0;
  const res = await callFinalize(event, { fetchImpl, requestBudgetMs: 0, consumeIntakeTokenImpl: async () => ({ first: true }), checkAndRecordRateLimitImpl: async () => { rateCalls += 1; return { allowed: true }; }, checkAndRecordDailyCapImpl: async () => ({ allowed: true }) });
  assert.equal(res.statusCode, 200, 'the broker still gets ok');
  assert.equal(rateCalls, 0, 'a spent budget must skip the store call, not start it');
}));

test('a hung release on the email-failed path is bounded: the broker gets 502 promptly', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re08/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: false, status: 500, text: async () => 'boom' };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const started = Date.now();
  const res = await callFinalize(event, { fetchImpl, consumeIntakeTokenImpl: async () => ({ first: true }), releaseIntakeTokenImpl: () => new Promise(() => {}) });
  assert.equal(res.statusCode, 502);
  assert.ok(Date.now() - started < 6000, 'a hung release must be cut off by its bound, not waited out');
}));

// A request that FAILED OPEN (store error/timeout) never owned the burn. Releasing it would delete
// whatever marker is stored, possibly a concurrent winner's.
test('a request that failed open does NOT release the token when the email then fails', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re04/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const fetchImpl = async (url) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: false, status: 500, text: async () => 'boom' };
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  let released = 0;
  const res = await callFinalize(event, { fetchImpl, consumeIntakeTokenImpl: async () => { throw new Error('blobs down'); }, releaseIntakeTokenImpl: async () => { released += 1; } });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'email_failed');
  assert.equal(released, 0, 'a request that never won the consume must not delete the stored marker');
}));

// The scoring backstop calls run AFTER the ledger row and both emails. A hung store there must not
// hold the function past its limit: the 2.5 s bound lets the response complete, scoring skipped.
test('a hung rate-limit backstop is bounded: the broker still gets ok, scoring is skipped', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-25_Acme_re05/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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
  const started = Date.now();
  const res = await callFinalize(event, { fetchImpl, consumeIntakeTokenImpl: async () => ({ first: true }), checkAndRecordRateLimitImpl: () => new Promise(() => {}), checkAndRecordDailyCapImpl: async () => ({ allowed: true }) });
  assert.equal(res.statusCode, 200);
  assert.ok(Date.now() - started < 6000, 'the hung backstop must be cut off by its bound, not waited out');
  assert.ok(!calls.some((u) => u.includes('broker-score-background')), 'scoring must be skipped when the backstop cannot answer');
}));

// Fake overrides for the rate-limit/daily-cap backstop (broker-score-store.js)
// so tests don't hit real Netlify Blobs (unavailable outside the Netlify
// runtime — would throw MissingBlobsEnvironmentError).
const allowAll = {
  checkAndRecordRateLimitImpl: async () => ({ allowed: true }),
  checkAndRecordDailyCapImpl: async () => ({ allowed: true }),
};

test('finalize triggers background scoring and returns a submissionId', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-07-18_Acme_ab12/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com', phone: '555-1234', market: 'Columbus', message: 'See attached' }) };
  const calls = [];
  let bgRequestBody = null;
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://contoso.sharepoint.com/x/om.pdf' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url.includes('/.netlify/functions/broker-score-background')) { bgRequestBody = JSON.parse(opts.body); return { ok: true, status: 202 }; }
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, { fetchImpl, ...allowAll });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(typeof body.submissionId, 'string');
  assert.ok(body.submissionId.length > 0);
  assert.ok(calls.some((u) => u.includes('/.netlify/functions/broker-score-background')));
  // authToken must be present and must cryptographically bind THIS
  // submissionId/itemPath pair — the fix for the unauthenticated
  // SharePoint-read exposure (cc-audit-army finding
  // unauth-sharepoint-read-oracle-via-background-fn) lives entirely in this
  // handoff, so a regression here would silently reopen it.
  assert.ok(bgRequestBody, 'broker-score-background must have been called');
  assert.equal(typeof bgRequestBody.authToken, 'string');
  const claims = verifyIntakeToken(bgRequestBody.authToken, 'intake-secret', 'bg-auth');
  assert.ok(claims, 'authToken must verify against INTAKE_TOKEN_SECRET and carry type "bg-auth"');
  assert.equal(claims.submissionId, body.submissionId);
  assert.equal(claims.itemPath, 'Broker Submissions/2026-07-18_Acme_ab12/om.pdf');

  // statusToken must be present and bound to this submissionId — the fix for the read-side half
  // of the unauthenticated oracle (broker-score-status.mjs used to accept any submissionId).
  assert.equal(typeof body.statusToken, 'string');
  const statusClaims = verifyIntakeToken(body.statusToken, 'intake-secret', 'status');
  assert.ok(statusClaims, 'statusToken must verify against INTAKE_TOKEN_SECRET and carry type "status"');
  assert.equal(statusClaims.submissionId, body.submissionId);
}));

test('finalize still succeeds even if triggering the background scorer fails outright', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-07-18_Acme_cd34/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-07-18_Acme_ef56/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-07-18_Acme_gh78/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-07-18_Acme_ij90/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
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

// 2026-09-30 audit (oxfordra.net item 5): the contact row was written before the submission id
// existed, so the contact row and the later score row shared no field and could not be joined.
test('the contact ledger row carries the same submission-id that is returned to the broker', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-30_Acme_jo01/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  let ledgerBody = null;
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) return { ok: true, status: 202 };
    if (url.includes('/.netlify/functions/broker-score-background')) return { ok: true, status: 202 };
    if (url === 'https://oxfordra.net/') { ledgerBody = new URLSearchParams(opts.body); return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, { fetchImpl, ...allowAll });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(ledgerBody, 'the ledger row must have been posted');
  assert.equal(ledgerBody.get('submission-id'), body.submissionId);
}));

// The ledger write used to be fire-and-forget with no trace at all: a Netlify
// Forms hiccup dropped the row silently. It must now land in pipeline-failures,
// but stay non-blocking — the broker still succeeds and Gabriel/Eric still get
// the email, because losing the ledger row is far less costly than losing the deal.
test('a failed ledger write is logged to pipeline-failures but does not block the email or the broker response', () => withEnv(ENV, async () => {
  const token = signIntakeToken({ type: 'upload', path: 'Broker Submissions/2026-09-28_Acme_lw01/om.pdf', size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
  const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
  const failureRows = [];
  let mails = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
    if (url.includes('sendMail')) { mails += 1; return { ok: true, status: 202 }; }
    if (url === 'https://oxfordra.net/') {
      const body = String(opts.body || '');
      if (body.includes('form-name=pipeline-failures')) { failureRows.push(body); return { ok: true, status: 200 }; }
      if (body.includes('form-name=broker-network-ledger')) return { ok: false, status: 500 };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await callFinalize(event, { fetchImpl, consumeIntakeTokenImpl: async () => ({ first: true }), checkAndRecordRateLimitImpl: async () => ({ allowed: false }), checkAndRecordDailyCapImpl: async () => ({ allowed: true }) });
  assert.equal(res.statusCode, 200, 'a ledger failure must not fail the broker submission');
  assert.equal(mails, 1, 'the email must still go out');
  assert.equal(failureRows.length, 1, 'exactly one pipeline-failures row for the failed ledger write');
  assert.ok(failureRows[0].includes('error-code=ledger_write_failed'), 'the row must carry the ledger_write_failed code');
  assert.ok(failureRows[0].includes('source-function=broker-finalize'));
}));

// Independent review 2026-10-01 (F3): the id is minted before the contact write, but the pipeline-failures
// rows logged after that point still recorded an empty submission-id, so they could not be joined.
test('failure rows logged after the id exists carry that submission-id (ledger write failure and email failure)', () => withEnv(ENV, async () => {
  const run = async (failWhat) => {
    const token = signIntakeToken({ type: 'upload', path: `Broker Submissions/2026-10-01_Acme_${failWhat}/om.pdf`, size: 30_000_000, exp: Date.now() + 60_000 }, 'intake-secret');
    const event = { httpMethod: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob Broker', company: 'Acme', email: 'b@acme.com' }) };
    const failureRows = [];
    let ledgerId = null;
    const fetchImpl = async (url, opts = {}) => {
      if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'item-1', size: 30_000_000, webUrl: 'https://x' }) };
      if (url.includes('sendMail')) return failWhat === 'email' ? { ok: false, status: 503 } : { ok: true, status: 202 };
      if (url.includes('/.netlify/functions/broker-score-background')) return { ok: true, status: 202 };
      if (url === 'https://oxfordra.net/') {
        const body = new URLSearchParams(String(opts.body || ''));
        if (body.get('form-name') === 'pipeline-failures') { failureRows.push(body); return { ok: true, status: 200 }; }
        if (body.get('form-name') === 'broker-network-ledger') { ledgerId = body.get('submission-id'); return failWhat === 'ledger' ? { ok: false, status: 500 } : { ok: true, status: 200 }; }
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const res = await callFinalize(event, { fetchImpl, ...allowAll });
    return { res, failureRows, ledgerId };
  };

  const ledger = await run('ledger');
  assert.equal(ledger.res.statusCode, 200);
  const lrow = ledger.failureRows.find((r) => r.get('error-code') === 'ledger_write_failed');
  assert.ok(lrow, 'a ledger_write_failed row must be logged');
  assert.ok(ledger.ledgerId, 'the contact row must carry an id');
  assert.equal(lrow.get('submission-id'), ledger.ledgerId);

  const email = await run('email');
  assert.equal(email.res.statusCode, 502);
  const erow = email.failureRows.find((r) => r.get('error-code') === 'email_failed');
  assert.ok(erow, 'an email_failed row must be logged');
  assert.equal(erow.get('submission-id'), email.ledgerId);
}));
