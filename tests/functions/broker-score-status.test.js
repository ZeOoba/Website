'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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

test('returns 405 for a non-GET request', async () => {
  const res = await handler({ httpMethod: 'POST' }, {});
  assert.equal(res.statusCode, 405);
});

test('returns 400 when submissionId is missing', async () => {
  const res = await handler({ httpMethod: 'GET', queryStringParameters: {} }, {});
  assert.equal(res.statusCode, 400);
});

test('returns pending when no result exists yet', async () => {
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1' } }, { readScoreResultImpl: async () => null });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'pending');
});

test('returns unavailable when the stored result says scoring failed', async () => {
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1' } }, { readScoreResultImpl: async () => ({ status: 'unavailable', reason: 'unparseable_file' }) });
  assert.equal(JSON.parse(res.body).status, 'unavailable');
});

test('returns ready with the score payload when the result is complete', async () => {
  const stored = { status: 'ready', finalScore: 82, gates: { propertyType: 'PASS', market: 'PASS' }, gateFailed: false, categories: [{ key: 'dealSize', label: 'Deal Size', earned: 25, possible: 25, excluded: false, note: 'x' }] };
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1' } }, { readScoreResultImpl: async () => stored });
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.equal(body.score, 82);
  assert.equal(body.categories.length, 1);
});

test('returns unavailable (not a 502) when the store throws, e.g. MissingBlobsEnvironmentError', async () => {
  const res = await handler(
    { httpMethod: 'GET', queryStringParameters: { submissionId: 'sub-1' } },
    { readScoreResultImpl: async () => { throw new Error('MissingBlobsEnvironmentError'); } },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'unavailable');
});
