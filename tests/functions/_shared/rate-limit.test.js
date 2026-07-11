'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRateLimit } = require('../../../netlify/functions/_shared/rate-limit.js');

function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    async get(key, { type }) {
      return data[key] === undefined ? null : type === 'json' ? data[key] : JSON.stringify(data[key]);
    },
    async setJSON(key, value) { data[key] = value; },
    _data: data,
  };
}

test('allows the first N requests within the window, then blocks', async () => {
  const store = fakeStore();
  const getStore = () => store;
  let now = 1_000_000;
  const opts = { getStore, limit: 3, windowMs: 60_000, now: () => now };
  assert.equal(await checkRateLimit('1.2.3.4', opts), true);
  assert.equal(await checkRateLimit('1.2.3.4', opts), true);
  assert.equal(await checkRateLimit('1.2.3.4', opts), true);
  assert.equal(await checkRateLimit('1.2.3.4', opts), false, '4th request in the window must be blocked');
});

test('resets after the window elapses', async () => {
  const store = fakeStore();
  const getStore = () => store;
  let now = 1_000_000;
  const opts = { getStore, limit: 1, windowMs: 60_000, now: () => now };
  assert.equal(await checkRateLimit('5.5.5.5', opts), true);
  assert.equal(await checkRateLimit('5.5.5.5', opts), false);
  now += 61_000;
  assert.equal(await checkRateLimit('5.5.5.5', opts), true, 'window elapsed, counter must reset');
});

test('tracks different keys independently', async () => {
  const store = fakeStore();
  const getStore = () => store;
  const opts = { getStore, limit: 1, windowMs: 60_000, now: () => 0 };
  assert.equal(await checkRateLimit('ip-a', opts), true);
  assert.equal(await checkRateLimit('ip-b', opts), true, 'a different key must have its own counter');
});
