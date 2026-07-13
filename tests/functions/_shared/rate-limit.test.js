'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRateLimit } = require('../../../netlify/functions/_shared/rate-limit.js');

// One shared in-memory table per fake client, standing in for a real
// Postgres connection — mirrors the query shapes issued by rate-limit.js's
// defaultGetClient (CREATE TABLE / SELECT / INSERT ON CONFLICT / UPDATE).
function fakeGetClient() {
  const table = new Map(); // key -> { window_start, count }
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

test('allows the first N requests within the window, then blocks', async () => {
  const getClient = fakeGetClient();
  let now = 1_000_000;
  const opts = { getClient, limit: 3, windowMs: 60_000, now: () => now };
  assert.equal(await checkRateLimit('1.2.3.4', opts), true);
  assert.equal(await checkRateLimit('1.2.3.4', opts), true);
  assert.equal(await checkRateLimit('1.2.3.4', opts), true);
  assert.equal(await checkRateLimit('1.2.3.4', opts), false, '4th request in the window must be blocked');
});

test('resets after the window elapses', async () => {
  const getClient = fakeGetClient();
  let now = 1_000_000;
  const opts = { getClient, limit: 1, windowMs: 60_000, now: () => now };
  assert.equal(await checkRateLimit('5.5.5.5', opts), true);
  assert.equal(await checkRateLimit('5.5.5.5', opts), false);
  now += 61_000;
  assert.equal(await checkRateLimit('5.5.5.5', opts), true, 'window elapsed, counter must reset');
});

test('tracks different keys independently', async () => {
  const getClient = fakeGetClient();
  const opts = { getClient, limit: 1, windowMs: 60_000, now: () => 0 };
  assert.equal(await checkRateLimit('ip-a', opts), true);
  assert.equal(await checkRateLimit('ip-b', opts), true, 'a different key must have its own counter');
});
