'use strict';

async function checkRateLimit(key, { getStore, limit = 20, windowMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const resolveStore = getStore || require('@netlify/blobs').getStore;
  const store = resolveStore({ name: 'rate-limits' });
  const blobKey = `rl:${key}`;
  const current = await store.get(blobKey, { type: 'json' });
  const nowMs = now();
  if (!current || current.windowStart + windowMs <= nowMs) {
    await store.setJSON(blobKey, { windowStart: nowMs, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  await store.setJSON(blobKey, { windowStart: current.windowStart, count: current.count + 1 });
  return true;
}

module.exports = { checkRateLimit };
