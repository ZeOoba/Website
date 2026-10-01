'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { signIntakeToken } = require('../../netlify/functions/_shared/validate.js');

// broker-score-status migrated to the Netlify V2 signature (ESM, Request in /
// Response out) on 2026-08-16, because a `handler` export marks a function as
// legacy V1 and Blobs auto-provisioning does not cover V1.
//
// The adapter below keeps the V1-shaped `event` literals and the
// {statusCode, body} assertions byte-identical: the transport changed, the
// behavioural contract these tests pin did not.
let statusModulePromise;
function loadStatus() {
  statusModulePromise ||= import(
    pathToFileURL(path.join(__dirname, '..', '..', 'netlify', 'functions', 'broker-score-status.mjs')).href
  );
  return statusModulePromise;
}

async function handler(event, deps) {
  const { handleScoreStatus } = await loadStatus();
  const url = new URL('https://oxfordra.net/api/broker-score-status');
  for (const [k, v] of Object.entries(event.queryStringParameters || {})) {
    url.searchParams.set(k, v);
  }
  const res = await handleScoreStatus(new Request(url, { method: event.httpMethod || 'GET' }), deps);
  return { statusCode: res.status, body: await res.text() };
}

// statusToken auth (2026-08-21 fix): this endpoint used to accept any caller-supplied
// submissionId unauthenticated -- the read-side half of the SharePoint oracle
// broker-score-background.mjs's authToken only closed the write side of. statusToken is minted
// by broker-finalize.mjs and cryptographically binds a submissionId to the browser that just
// submitted it.
const SECRET = 'status-test-secret';
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) process.env[k] = prev[k]; });
}
function validStatusToken(submissionId) {
  return signIntakeToken({ type: 'status', submissionId, exp: Date.now() + 60_000 }, SECRET);
}

test('returns 405 for a non-GET request', async () => {
  const res = await handler({ httpMethod: 'POST' }, {});
  assert.equal(res.statusCode, 405);
});

test('returns 400 when submissionId is missing', async () => {
  const res = await handler({ httpMethod: 'GET', queryStringParameters: {} }, {});
  assert.equal(res.statusCode, 400);
});

test('returns 401 when statusToken is missing', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1' } }, {});
  assert.equal(res.statusCode, 401);
}));

test('returns 401 when statusToken is bound to a DIFFERENT submissionId', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = validStatusToken('sub-1');
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-2', statusToken } }, {});
  assert.equal(res.statusCode, 401);
}));

test('returns 401 when statusToken is signed with the wrong secret', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = signIntakeToken({ type: 'status', submissionId: 'sub-1', exp: Date.now() + 60_000 }, 'wrong-secret');
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1', statusToken } }, {});
  assert.equal(res.statusCode, 401);
}));

test('returns pending when no result exists yet', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = validStatusToken('sub-1');
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1', statusToken } }, { readScoreResultImpl: async () => null });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'pending');
}));

test('returns unavailable when the stored result says scoring failed', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = validStatusToken('sub-1');
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1', statusToken } }, { readScoreResultImpl: async () => ({ status: 'unavailable', reason: 'unparseable_file' }) });
  assert.equal(JSON.parse(res.body).status, 'unavailable');
}));

test('returns ready with the score payload when the result is complete', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = validStatusToken('sub-1');
  const stored = { status: 'ready', finalScore: 82, gates: { propertyType: 'PASS', market: 'PASS' }, gateFailed: false, categories: [{ key: 'dealSize', label: 'Deal Size', earned: 25, possible: 25, excluded: false, note: 'x' }] };
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1', statusToken } }, { readScoreResultImpl: async () => stored });
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.equal(body.score, 82);
  assert.equal(body.categories.length, 1);
}));

test('returns unavailable (not a 502) when the store throws, e.g. MissingBlobsEnvironmentError', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = validStatusToken('sub-1');
  const res = await handler(
    { httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1', statusToken } },
    { readScoreResultImpl: async () => { throw new Error('MissingBlobsEnvironmentError'); } },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'unavailable');
}));

// 2026-09-30 audit (oxfordra.net items 3 and 4).
test('never returns internalNote to the broker, even if the stored result carries it', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = validStatusToken('sub-1');
  const stored = { status: 'ready', finalScore: 82, gates: { propertyType: 'PASS', market: 'PASS' }, gateFailed: false, coveragePct: 100, insufficientData: false, categories: [{ key: 'basis', label: 'Basis', earned: 0, possible: 25, excluded: false, note: 'Above the floor.', internalNote: 'SECRET floor of $230.12/SF' }] };
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1', statusToken } }, { readScoreResultImpl: async () => stored });
  assert.doesNotMatch(res.body, /SECRET|230\.12|internalNote/);
  assert.equal(JSON.parse(res.body).categories[0].note, 'Above the floor.');
}));

test('reports unavailable, not a score, when the stored result has insufficient data', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const statusToken = validStatusToken('sub-1');
  const stored = { status: 'ready', finalScore: null, gates: { propertyType: 'NOT_VERIFIED', market: 'NOT_VERIFIED' }, gateFailed: false, coveragePct: 35, insufficientData: true, categories: [] };
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1', statusToken } }, { readScoreResultImpl: async () => stored });
  assert.equal(JSON.parse(res.body).status, 'unavailable');
}));
