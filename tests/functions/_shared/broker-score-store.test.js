'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  writeScoreResult, readScoreResult, hasBeenScored, markScored,
  checkAndRecordRateLimit, checkAndRecordDailyCap,
} = require('../../../netlify/functions/_shared/broker-score-store.js');

// A tiny in-memory fake matching @netlify/blobs's getStore(name) -> {setJSON,get,delete} shape.
function fakeStoreFactory() {
  const data = new Map();
  return function getStore(name) {
    const ns = name;
    return {
      async setJSON(key, value) { data.set(`${ns}:${key}`, value); },
      async get(key, { type } = {}) { return data.has(`${ns}:${key}`) ? data.get(`${ns}:${key}`) : null; },
      async delete(key) { data.delete(`${ns}:${key}`); },
    };
  };
}

test('writeScoreResult then readScoreResult round-trips the result', async () => {
  const storeFactory = fakeStoreFactory();
  await writeScoreResult('sub-1', { status: 'ready', finalScore: 82 }, { storeFactory });
  const result = await readScoreResult('sub-1', { storeFactory });
  assert.equal(result.status, 'ready');
  assert.equal(result.finalScore, 82);
});

test('readScoreResult returns null for an unknown submissionId', async () => {
  const storeFactory = fakeStoreFactory();
  const result = await readScoreResult('nonexistent', { storeFactory });
  assert.equal(result, null);
});

test('readScoreResult returns null and deletes an expired entry', async () => {
  const storeFactory = fakeStoreFactory();
  await writeScoreResult('sub-2', { status: 'ready', finalScore: 50 }, { storeFactory });
  // Manually force expiry by writing an already-past expiresAt directly.
  const store = storeFactory('broker-score-results');
  const stored = await store.get('sub-2', { type: 'json' });
  await store.setJSON('sub-2', { ...stored, expiresAt: Date.now() - 1000 });
  const result = await readScoreResult('sub-2', { storeFactory });
  assert.equal(result, null);
});

test('hasBeenScored is false before markScored and true after', async () => {
  const storeFactory = fakeStoreFactory();
  assert.equal(await hasBeenScored('Broker Submissions/x/om.pdf', { storeFactory }), false);
  await markScored('Broker Submissions/x/om.pdf', { storeFactory });
  assert.equal(await hasBeenScored('Broker Submissions/x/om.pdf', { storeFactory }), true);
});

test('checkAndRecordRateLimit allows up to the per-IP cap then blocks', async () => {
  const storeFactory = fakeStoreFactory();
  for (let i = 0; i < 5; i++) {
    const r = await checkAndRecordRateLimit('1.2.3.4', { storeFactory });
    assert.equal(r.allowed, true);
  }
  const blocked = await checkAndRecordRateLimit('1.2.3.4', { storeFactory });
  assert.equal(blocked.allowed, false);
});

test('checkAndRecordRateLimit tracks each IP independently', async () => {
  const storeFactory = fakeStoreFactory();
  for (let i = 0; i < 5; i++) await checkAndRecordRateLimit('1.1.1.1', { storeFactory });
  const otherIp = await checkAndRecordRateLimit('2.2.2.2', { storeFactory });
  assert.equal(otherIp.allowed, true);
});

test('checkAndRecordDailyCap allows up to the daily cap then blocks', async () => {
  const storeFactory = fakeStoreFactory();
  for (let i = 0; i < 50; i++) {
    const r = await checkAndRecordDailyCap({ storeFactory });
    assert.equal(r.allowed, true);
  }
  const blocked = await checkAndRecordDailyCap({ storeFactory });
  assert.equal(blocked.allowed, false);
});
