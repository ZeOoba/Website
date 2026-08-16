// ESM so Netlify's esbuild bundles @netlify/blobs directly into the function.
// As CommonJS reached from an ESM entry, esbuild left require('@netlify/blobs')
// as an unresolvable runtime call -- verified broken on deploy-preview-72.
import { getStore } from '@netlify/blobs';

const RESULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — comfortably longer than any broker's poll window
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_PER_IP = 5;
const DAILY_SPEND_CAP = 50; // hard backstop on scoring attempts per UTC calendar day

// @netlify/blobs has no native TTL — every value below carries its own
// expiresAt and callers check/delete it manually, per current Netlify Blobs
// documentation (verified during planning).

async function writeScoreResult(submissionId, result, { storeFactory = getStore } = {}) {
  const store = storeFactory('broker-score-results');
  await store.setJSON(submissionId, { ...result, expiresAt: Date.now() + RESULT_TTL_MS });
}

async function readScoreResult(submissionId, { storeFactory = getStore } = {}) {
  const store = storeFactory('broker-score-results');
  const value = await store.get(submissionId, { type: 'json' });
  if (!value) return null;
  if (value.expiresAt && value.expiresAt < Date.now()) {
    await store.delete(submissionId);
    return null;
  }
  return value;
}

async function hasBeenScored(sharepointItemPath, { storeFactory = getStore } = {}) {
  const store = storeFactory('broker-score-dedupe');
  const value = await store.get(sharepointItemPath, { type: 'json' });
  if (!value) return false;
  if (value.expiresAt && value.expiresAt < Date.now()) {
    await store.delete(sharepointItemPath);
    return false;
  }
  return true;
}

async function markScored(sharepointItemPath, { storeFactory = getStore } = {}) {
  const store = storeFactory('broker-score-dedupe');
  await store.setJSON(sharepointItemPath, { scoredAt: Date.now(), expiresAt: Date.now() + DEDUPE_TTL_MS });
}

async function checkAndRecordRateLimit(ip, { storeFactory = getStore } = {}) {
  const store = storeFactory('broker-score-rate-limits');
  const key = `ip:${ip}`;
  const now = Date.now();
  const existing = (await store.get(key, { type: 'json' })) || { hits: [] };
  const recentHits = (existing.hits || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recentHits.length >= RATE_LIMIT_MAX_PER_IP) return { allowed: false };
  recentHits.push(now);
  await store.setJSON(key, { hits: recentHits });
  return { allowed: true };
}

async function checkAndRecordDailyCap({ storeFactory = getStore } = {}) {
  const store = storeFactory('broker-score-rate-limits');
  const dayKey = `day:${new Date().toISOString().slice(0, 10)}`;
  const existing = (await store.get(dayKey, { type: 'json' })) || { count: 0 };
  if (existing.count >= DAILY_SPEND_CAP) return { allowed: false };
  await store.setJSON(dayKey, { count: existing.count + 1 });
  return { allowed: true };
}

export {
  writeScoreResult, readScoreResult, hasBeenScored, markScored,
  checkAndRecordRateLimit, checkAndRecordDailyCap,
};
