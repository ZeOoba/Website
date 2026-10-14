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

// Single-use intake tokens. verifyIntakeToken proves the HMAC and the expiry
// but nothing stopped the same token being finalized again for its whole TTL —
// each replay wrote a ledger row and emailed both principals off one reCAPTCHA
// solve. Keyed on the token's SharePoint path (unique per upload session).
const CONSUMED_TTL_MS = 24 * 60 * 60 * 1000; // outlives any intake token TTL by a wide margin

// The conditional writes below are what make the burn ATOMIC: a plain get-then-set let N
// concurrent finalizes with one token all read "absent" and all win (10 concurrent POSTs
// -> 10 ledger rows + 20 emails; adversarial review of PR #166).
//
// MUST be store.set() with a JSON string, NOT store.setJSON(): in @netlify/blobs 10.7.9
// setJSON accepts onlyIfNew/onlyIfMatch but drops them (verified on the wire: set sends
// `If-None-Match: *`, setJSON sends nothing), which would make this a silent non-atomic
// no-op. tests/functions/_shared/broker-score-store.test.js pins the header on the wire.
// Do not request consistency:'strong' here: the client throws BlobsConsistencyError when the
// environment has no uncachedEdgeURL, which would push every consume onto the fail-open path.
const consumedStore = (storeFactory) => storeFactory('broker-intake-consumed');

async function consumeIntakeToken(key, { storeFactory = getStore } = {}) {
  const store = consumedStore(storeFactory);
  const marker = () => JSON.stringify({ consumedAt: Date.now(), expiresAt: Date.now() + CONSUMED_TTL_MS });
  const won = (r) => {
    // A store that does not report `modified` cannot prove atomicity: throw so the
    // caller fails open AND logs (intake_consume_unavailable), never a silent double-win.
    if (!r || typeof r.modified !== 'boolean') throw new Error('broker-intake-consumed: conditional write did not report `modified`');
    return r.modified;
  };

  // Common case: first use. Create-only write; exactly one concurrent caller gets modified:true.
  if (won(await store.set(key, marker(), { onlyIfNew: true }))) return { first: true };

  // A marker exists. Live -> replay. Expired (past the 24h TTL) or deleted in between -> take it over,
  // again atomically (etag-guarded replace, or create-only if it vanished). A stale read here can only
  // make the takeover lose (stale etag -> modified:false), which is the safe direction.
  const cur = await store.getWithMetadata(key, { type: 'json' });
  if (!cur) return { first: won(await store.set(key, marker(), { onlyIfNew: true })) };
  const data = cur.data;
  if (data && (!data.expiresAt || data.expiresAt > Date.now())) return { first: false };
  return { first: won(await store.set(key, marker(), { onlyIfMatch: cur.etag })) };
}

// Undo a consume when the request failed AFTER the burn (email send threw):
// the broker's retry must be able to finish, or the document sits in
// SharePoint with a ledger row and no notification, permanently.
async function releaseIntakeToken(key, { storeFactory = getStore } = {}) {
  const store = consumedStore(storeFactory);
  await store.delete(key);
}

export {
  writeScoreResult, readScoreResult, hasBeenScored, markScored,
  checkAndRecordRateLimit, checkAndRecordDailyCap, consumeIntakeToken, releaseIntakeToken,
};
