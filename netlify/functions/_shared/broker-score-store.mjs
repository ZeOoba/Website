// ESM so Netlify's esbuild bundles @netlify/blobs directly into the function.
// As CommonJS reached from an ESM entry, esbuild left require('@netlify/blobs')
// as an unresolvable runtime call -- verified broken on deploy-preview-72.
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

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
  // A per-call nonce lets the read-back tell OUR marker from someone else's. Without it a failed write
  // (the real client reports {modified:true, etag:''} for every non-412 status: 400/401/403/404/409/429/
  // 5xx; adversarial review of PR #167) could read back an already-present marker and call it a win:
  // a replay, or a concurrent loser, silently getting first:true.
  const nonce = randomUUID();
  const marker = () => JSON.stringify({ nonce, consumedAt: Date.now(), expiresAt: Date.now() + CONSUMED_TTL_MS });
  const live = (d) => !!d && (!d.expiresAt || d.expiresAt > Date.now());
  const reported = (r) => {
    // A store that does not report `modified` cannot prove atomicity: throw so the caller fails open
    // AND logs (intake_consume_unavailable), never a silent double-win.
    if (!r || typeof r.modified !== 'boolean') throw new Error('broker-intake-consumed: conditional write did not report `modified`');
    return r;
  };

  // Decide a write from what is actually stored. Our nonce -> we won (even if the write was reported
  // as lost: a retried PUT whose first attempt committed gets a 412). Someone else's live marker ->
  // a replay or a lost race, NEVER a win and never a throw (a throw would fail open and let it through).
  // Nothing provable stored -> throw so the caller fails open AND logs.
  const verdict = async () => {
    const back = await store.getWithMetadata(key, { type: 'json' });
    const d = back && back.data;
    if (d && d.nonce === nonce) return true;
    if (live(d)) return false;
    throw new Error('broker-intake-consumed: write not confirmed and no live marker is stored');
  };
  // A genuine success carries an etag. modified:true WITHOUT one is unproven (failed write, or an
  // etag-less success): confirm it from the stored marker or throw. modified:false is an AUTHORITATIVE
  // 412 (a marker exists), so it must never fail open: our nonce on read-back means we won, anything
  // else (another caller's marker, or a stale/eventually-consistent 404) means replay. Throwing there
  // let a replay through whenever the read right after a 412 lagged (adversarial review of PR #167, round 3).
  const resolve = async (r) => {
    reported(r);
    if (r.modified && r.etag) return true;
    if (r.modified) return verdict();
    const back = await store.getWithMetadata(key, { type: 'json' });
    return !!(back && back.data && back.data.nonce === nonce);
  };

  // Common case: first use. Create-only write; exactly one concurrent caller gets modified:true.
  const first = reported(await store.set(key, marker(), { onlyIfNew: true }));
  if (first.modified) return { first: await resolve(first) };

  // 412: a marker exists. Ours (a retried PUT that had committed) -> win. ANY other marker, live OR expired,
  // is a replay. There is deliberately NO takeover of an expired marker:
  //   - it would need an If-Match replace, and the live Netlify Blobs service does NOT make that atomic under
  //     contention (probe 2026-10-15: 20 concurrent writers holding one etag, 8 to 13 succeeded), so a
  //     takeover could hand the same token to several callers;
  //   - it is unreachable anyway: markers live 24 h, intake tokens expire after 15 min and the key is a
  //     unique per-upload-session path, so a token that still verifies never meets an expired marker.
  // (The create-only paths above and below ARE atomic: exactly one winner of 30 concurrent writers, 4 of 4.)
  //
  // From here on the server has AUTHORITATIVELY told us a marker is stored, so a throw in anything that
  // follows (a read 401/403/5xx, unparseable marker JSON, a failed follow-up write) must not fail open and
  // let a replay through: it is a replay (adversarial review of PR #167, round 4: 143/143 post-412 read
  // faults threw). The only fail-open left is a fault BEFORE any 412, where nothing is known.
  try {
    const cur = await store.getWithMetadata(key, { type: 'json' });
    // Released (deleted) between the 412 and this read: create-only again, still atomic.
    if (!cur) return { first: await resolve(await store.set(key, marker(), { onlyIfNew: true })) };
    return { first: !!(cur.data && cur.data.nonce === nonce) };
  } catch (err) {
    console.error('[broker-score-store] read/write after a 412 failed; treating as a replay', String(err));
    return { first: false };
  }
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
