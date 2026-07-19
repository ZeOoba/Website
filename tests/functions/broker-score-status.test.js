'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../../netlify/functions/broker-score-status.js');

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
