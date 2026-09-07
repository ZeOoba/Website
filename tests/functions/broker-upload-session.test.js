'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler, __resetRateLimit, RATE_DEFAULT } = require('../../netlify/functions/broker-upload-session.js');

// The per-IP rate-limit buckets are module-level state shared by every test in
// this file. Without this, tests would silently consume one another's budget
// and the failure would present as an unrelated 429 in whichever test ran last.
test.beforeEach(() => { __resetRateLimit(); });

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

// reCAPTCHA enforcement is back on (2026-09-07 — see the comment in
// broker-upload-session.js; it was temporarily disabled from 2026-07-19).
// These tests assert the enforced behavior: a failed/thrown/missing
// recaptcha check must 403 the request BEFORE any Graph work OR intake
// logging runs. The guard below matches on HOST, not on a path shape
// graph-files.js happens to build today (an item-id-form Graph URL or a
// /children POST would slip past a path-substring match unflagged), and
// counts calls so the proof is in an assertion, not in a default-throw stub.
function trackCalls(fetchImpl) {
  const calls = { graph: 0, forms: 0 };
  const wrapped = async (url, opts = {}) => {
    let host;
    try { host = new URL(url).hostname; } catch { host = ''; }
    if (host === 'login.microsoftonline.com' || host === 'graph.microsoft.com') { calls.graph += 1; }
    if (url === 'https://oxfordra.net/' && !String(opts.body || '').includes('pipeline-failures')) { calls.forms += 1; }
    return fetchImpl(url, opts);
  };
  return { fetchImpl: wrapped, calls };
}

test('rejects with 403 when the recaptcha token does not verify, and writes no intake row or Graph session', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'bad-token' }) };
  const { fetchImpl, calls } = trackCalls(async (url) => {
    if (url.includes('recaptcha/api/siteverify')) return { ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'recaptcha_failed');
  assert.equal(calls.graph, 0, 'a 403 must never reach Graph');
  assert.equal(calls.forms, 0, 'a routine failed challenge must not write a broker-submission-intake row');
}));

test('rejects with 403 when an empty/missing recaptchaToken is sent, without calling the network at all', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme' }) };
  const { fetchImpl, calls } = trackCalls(async (url) => { throw new Error(`must not call network: ${url}`); });
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'recaptcha_failed');
  assert.equal(calls.graph, 0);
}));

test('rejects with 403 when verifyRecaptcha throws — e.g. a network-level failure calling siteverify', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'good-token' }) };
  const { fetchImpl, calls } = trackCalls(async (url) => {
    if (url.includes('recaptcha/api/siteverify')) throw new Error('ECONNRESET');
    throw new Error(`unexpected fetch: ${url}`);
  });
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'recaptcha_failed');
  assert.equal(calls.graph, 0);
}));

test('rejects with 403 when verifyRecaptcha throws due to missing RECAPTCHA_SECRET_KEY (fails closed, not open)', () => withEnv({ ...ENV, RECAPTCHA_SECRET_KEY: '' }, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'good-token' }) };
  const { fetchImpl, calls } = trackCalls(async (url) => { throw new Error(`must not call network: ${url}`); });
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'recaptcha_failed');
  assert.equal(calls.graph, 0);
}));

test('rejects with 403 when Google itself errors (non-2xx from siteverify), failing closed', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'good-token' }) };
  const { fetchImpl, calls } = trackCalls(async (url) => {
    if (url.includes('recaptcha/api/siteverify')) return { ok: false, status: 503 };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.graph, 0);
}));

// This is the observability fix for the exact gap that made a 2026-09-07
// secret misconfiguration invisible: a config-class Google error must reach
// pipeline-failures (Notion-visible), not just a function log nobody tails.
test('logs a pipeline-failures row — not just console — when Google reports a config-class error like invalid-input-secret', () => withEnv(ENV, async () => {
  const event = { httpMethod: 'POST', body: JSON.stringify({ fileName: 'om.pdf', fileSize: 1000, company: 'Acme', recaptchaToken: 'good-token' }) };
  let loggedFailure = null;
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('recaptcha/api/siteverify')) return { ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-secret'] }) };
    if (url === 'https://oxfordra.net/') { loggedFailure = String(opts.body || ''); return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await handler(event, { fetchImpl });
  assert.equal(res.statusCode, 403);
  assert.ok(loggedFailure, 'a config-class recaptcha error must be logged to pipeline-failures');
  assert.ok(loggedFailure.includes('recaptcha_config_error'));
  assert.ok(loggedFailure.includes('invalid-input-secret'));
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

// ---------- Interim per-IP rate limit ----------
// Added while reCAPTCHA was logged-but-not-enforced (2026-07-19 hotfix,
// closed out 2026-09-07). Kept as a second, cheap layer now that reCAPTCHA
// enforcement is back on, per broker-upload-session.js's own rationale.

function validBody(n) {
  return JSON.stringify({ name: 'Bob', company: `Acme ${n}`, email: 'b@acme.com', fileName: 'om.pdf', fileSize: 1000, contentType: 'application/pdf', recaptchaToken: 'good-token' });
}
function eventFrom(ip, n) {
  return { httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip }, body: validBody(n) };
}
function graphOk() {
  return withRecaptchaPass(async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/') return { ok: true, status: 200, _body: String(opts.body || '') };
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes(':/createUploadSession')) return { ok: true, status: 200, json: async () => ({ uploadUrl: 'https://contoso.sharepoint.com/upload/s1', expirationDateTime: '2026-07-11T00:00:00Z' }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
}

test(`allows requests up to the ${RATE_DEFAULT}-per-IP window limit`, () => withEnv(ENV, async () => {
  for (let i = 0; i < RATE_DEFAULT; i += 1) {
    const res = await handler(eventFrom('203.0.113.10', i), { fetchImpl: graphOk() });
    assert.equal(res.statusCode, 200, `request ${i + 1} of ${RATE_DEFAULT} must be under the limit`);
    assert.equal(JSON.parse(res.body).uploadUrl, 'https://contoso.sharepoint.com/upload/s1');
  }
}));

test('returns 429 with retry-after once the per-IP limit is exceeded, and mints no session', () => withEnv(ENV, async () => {
  for (let i = 0; i < RATE_DEFAULT; i += 1) {
    await handler(eventFrom('203.0.113.11', i), { fetchImpl: graphOk() });
  }
  // The over-limit call must be rejected BEFORE any Graph work — the only
  // network call it may make is the pipeline-failures log write.
  let loggedFailure = null;
  const res = await handler(eventFrom('203.0.113.11', 99), {
    fetchImpl: async (url, opts = {}) => {
      if (url === 'https://oxfordra.net/') { loggedFailure = String(opts.body || ''); return { ok: true, status: 200 }; }
      throw new Error(`must not call anything else once rate limited: ${url}`);
    },
  });
  assert.equal(res.statusCode, 429);
  assert.equal(JSON.parse(res.body).error, 'rate_limited');
  assert.equal(JSON.parse(res.body).ok, false);
  assert.ok(Number(res.headers['retry-after']) > 0, 'a 429 must tell the caller when to retry');
  assert.ok(loggedFailure, 'the rate-limit rejection must be logged, per this function\'s fail-loudly convention');
  assert.ok(loggedFailure.includes('pipeline-failures'), 'it must go to the pipeline-failures form');
  assert.ok(loggedFailure.includes('rate_limited'), 'the logged row must carry the rate_limited error code');
}));

test('rate-limit buckets are per IP — one exhausted IP does not block another', () => withEnv(ENV, async () => {
  for (let i = 0; i < RATE_DEFAULT; i += 1) {
    await handler(eventFrom('203.0.113.12', i), { fetchImpl: graphOk() });
  }
  const blocked = await handler(eventFrom('203.0.113.12', 99), { fetchImpl: graphOk() });
  assert.equal(blocked.statusCode, 429);

  const other = await handler(eventFrom('198.51.100.7', 0), { fetchImpl: graphOk() });
  assert.equal(other.statusCode, 200, 'a different IP must still be served');
}));

test('the limit is overridable via BROKER_UPLOAD_RATE_LIMIT_PER_10MIN', () => withEnv({ ...ENV, BROKER_UPLOAD_RATE_LIMIT_PER_10MIN: '2' }, async () => {
  assert.equal((await handler(eventFrom('203.0.113.13', 0), { fetchImpl: graphOk() })).statusCode, 200);
  assert.equal((await handler(eventFrom('203.0.113.13', 1), { fetchImpl: graphOk() })).statusCode, 200);
  assert.equal((await handler(eventFrom('203.0.113.13', 2), { fetchImpl: graphOk() })).statusCode, 429);
}));

test('falls back to x-forwarded-for when the Netlify client-IP header is absent', () => withEnv({ ...ENV, BROKER_UPLOAD_RATE_LIMIT_PER_10MIN: '1' }, async () => {
  const ev = () => ({ httpMethod: 'POST', headers: { 'x-forwarded-for': '203.0.113.14, 10.0.0.1' }, body: validBody(0) });
  assert.equal((await handler(ev(), { fetchImpl: graphOk() })).statusCode, 200);
  assert.equal((await handler(ev(), { fetchImpl: graphOk() })).statusCode, 429);
}));
