// THROWAWAY LIVE PROBE -- DO NOT MERGE. Lives only on branch probe/blobs-live-check, to be run against a
// Netlify DEPLOY PREVIEW, then the branch/PR is closed and deleted.
//
// Why: PR #167's atomic consume (netlify/functions/_shared/broker-score-store.mjs) depends on behaviors of the
// REAL Netlify Blobs service that unit tests with a faked fetch cannot show: that If-None-Match / If-Match
// are enforced (412) under real contention, that a successful write carries an ETag, whether a read right
// after a write/412 can be stale, and how delete behaves. This also tests the pattern a global alert throttle
// (review of PR #162's signature alert) would use. It calls the REAL consumeIntakeToken, only swapping the
// store NAME to a scratch store so no real intake token key is ever touched.
//
// Safety: refuses to do anything unless the Netlify deploy context is exactly 'deploy-preview'; requires the
// shared constant below; writes only to the scratch store 'zz-consume-probe'; deletes it at the end.
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';
import { consumeIntakeToken, releaseIntakeToken } from './_shared/broker-score-store.mjs';

const KEY = 'r7q9-probe-2026-10-15';
const SCRATCH = 'zz-consume-probe';

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deployContext() {
  let ctx;
  try { ctx = globalThis.Netlify?.context?.deploy?.context; } catch { /* not exposed */ }
  return ctx ?? process.env.CONTEXT ?? null;
}

async function timed(fn) {
  const t0 = Date.now();
  try { const value = await fn(); return { ok: true, ms: Date.now() - t0, value }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: `${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 200)}` }; }
}

const storeFactory = () => getStore(SCRATCH);

export default async (req) => {
  const p = new URL(req.url).searchParams;
  if (p.get('k') !== KEY) return json(404, { error: 'not found' });

  const context = deployContext();
  const info = {
    context,
    netlifyGlobal: typeof globalThis.Netlify !== 'undefined',
    env: { CONTEXT: process.env.CONTEXT ?? null, NETLIFY: process.env.NETLIFY ?? null, hasDeployId: !!process.env.DEPLOY_ID },
    node: process.version,
    now: new Date().toISOString(),
  };
  if (p.get('info') === '1') return json(200, info);
  if (context !== 'deploy-preview') return json(403, { refused: true, reason: 'not a deploy preview', info });

  // Function time-limit probe: GET ?sleep=N (seconds, max 40) shows where the platform cuts a request off.
  if (p.get('sleep')) {
    const s = Math.min(Math.max(Number(p.get('sleep')) || 0, 0), 40);
    const t0 = Date.now();
    await sleep(s * 1000);
    return json(200, { slept: s, actualMs: Date.now() - t0 });
  }

  const run = randomUUID().slice(0, 8);
  const report = { info, run, tests: {} };
  const store = storeFactory();
  const rec = (name, ok, detail) => { report.tests[name] = { ok, ...detail }; };

  // T1: N concurrent consumes of ONE key with the REAL code: exactly one winner.
  for (const n of [10, 30]) {
    const key = `race${n}-${run}`;
    const results = await Promise.all(Array.from({ length: n }, () => timed(() => consumeIntakeToken(key, { storeFactory }))));
    const winners = results.filter((r) => r.ok && r.value.first).length;
    const losers = results.filter((r) => r.ok && !r.value.first).length;
    const threw = results.filter((r) => !r.ok);
    rec(`T1_race_${n}`, winners === 1 && threw.length === 0, {
      winners, losers, threw: threw.length, firstErrors: threw.slice(0, 2).map((r) => r.error),
      msMin: Math.min(...results.map((r) => r.ms)), msMax: Math.max(...results.map((r) => r.ms)),
    });
  }

  // T2: sequential replay is rejected (the server enforced If-None-Match with a 412).
  {
    const key = `seq-${run}`;
    const a = await timed(() => consumeIntakeToken(key, { storeFactory }));
    const b = await timed(() => consumeIntakeToken(key, { storeFactory }));
    const c = await timed(() => consumeIntakeToken(key, { storeFactory }));
    rec('T2_sequential_replay', a.ok && a.value.first === true && b.ok && b.value.first === false && c.ok && c.value.first === false,
      { first: a.value ?? a.error, second: b.value ?? b.error, third: c.value ?? c.error, ms: [a.ms, b.ms, c.ms] });
  }

  // T3: raw client semantics the fix relies on (ETag on success, 412 -> modified:false, If-Match enforcement).
  {
    const key = `raw-${run}`;
    const body = JSON.stringify({ a: 1 });
    const a = await timed(() => store.set(key, body, { onlyIfNew: true }));
    const b = await timed(() => store.set(key, body, { onlyIfNew: true }));
    const g = await timed(() => store.getWithMetadata(key, { type: 'json' }));
    const wrong = await timed(() => store.set(key, body, { onlyIfMatch: '"definitely-not-the-etag"' }));
    const right = await timed(() => g.ok && g.value ? store.set(key, body, { onlyIfMatch: g.value.etag }) : Promise.reject(new Error('no etag')));
    const afterSwap = await timed(() => store.set(key, body, { onlyIfMatch: g.value?.etag }));
    rec('T3_raw_conditionals', !!(a.ok && a.value.modified === true && a.value.etag && b.ok && b.value.modified === false &&
      g.ok && g.value?.etag && wrong.ok && wrong.value.modified === false && right.ok && right.value.modified === true &&
      afterSwap.ok && afterSwap.value.modified === false), {
      firstSet: a.value ?? a.error, secondSetOnlyIfNew: b.value ?? b.error, getEtag: g.value?.etag ?? g.error,
      onlyIfMatchWrong: wrong.value ?? wrong.error, onlyIfMatchRight: right.value ?? right.error, staleEtagAfterSwap: afterSwap.value ?? afterSwap.error,
    });
  }

  // T4: read-after-write and read-after-412 staleness: how often does the very next read miss?
  {
    let missAfterWrite = 0; let missAfter412 = 0; const trials = 15;
    for (let i = 0; i < trials; i += 1) {
      const key = `raw-stale-${run}-${i}`;
      await store.set(key, JSON.stringify({ i }), { onlyIfNew: true });
      const r1 = await store.getWithMetadata(key, { type: 'json' });
      if (!r1 || !r1.data) missAfterWrite += 1;
      await store.set(key, JSON.stringify({ i }), { onlyIfNew: true }); // a 412
      const r2 = await store.getWithMetadata(key, { type: 'json' });
      if (!r2 || !r2.data) missAfter412 += 1;
    }
    rec('T4_read_staleness', true, { trials, missAfterWrite, missAfter412, note: 'ok:true is informational; any miss means eventual-consistency reads are observable' });
  }

  // T5: release (delete) then re-consume; and delete visibility to the very next conditional create.
  {
    const key = `rel-${run}`;
    const a = await timed(() => consumeIntakeToken(key, { storeFactory }));
    const rel = await timed(() => releaseIntakeToken(key, { storeFactory }));
    const b = await timed(() => consumeIntakeToken(key, { storeFactory }));
    const c = await timed(() => consumeIntakeToken(key, { storeFactory }));
    const relAbsent = await timed(() => releaseIntakeToken(`absent-${run}`, { storeFactory }));
    rec('T5_release_then_reconsume', a.ok && a.value.first && rel.ok && b.ok && b.value.first === true && c.ok && c.value.first === false,
      { a: a.value ?? a.error, release: rel.ok ? 'ok' : rel.error, afterRelease: b.value ?? b.error, again: c.value ?? c.error, deleteOfAbsentKey: relAbsent.ok ? 'ok' : relAbsent.error });
  }

  // T6: expired-marker takeover is atomic under contention (exactly one winner), and a legacy no-nonce marker is a replay.
  {
    const key = `expired-${run}`;
    await store.set(key, JSON.stringify({ consumedAt: 1, expiresAt: Date.now() - 60_000 }), { onlyIfNew: true });
    const results = await Promise.all(Array.from({ length: 8 }, () => timed(() => consumeIntakeToken(key, { storeFactory }))));
    const winners = results.filter((r) => r.ok && r.value.first).length;
    const legacyKey = `legacy-${run}`;
    await store.set(legacyKey, JSON.stringify({ consumedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }), { onlyIfNew: true });
    const legacy = await timed(() => consumeIntakeToken(legacyKey, { storeFactory }));
    rec('T6_takeover_and_legacy', winners === 1 && legacy.ok && legacy.value.first === false,
      { expiredMarkerWinners: winners, threw: results.filter((r) => !r.ok).length, legacyMarkerFirst: legacy.value ?? legacy.error });
  }

  // T7: the pattern a GLOBAL once-per-window alert throttle would use: N concurrent claimers, exactly one may "send".
  {
    const key = `alert-window-${run}`;
    const WINDOW = 3_600_000;
    const claim = async () => {
      const now = Date.now();
      const first = await store.set(key, JSON.stringify({ lastSentAt: now }), { onlyIfNew: true });
      if (first.modified) return true;
      const cur = await store.getWithMetadata(key, { type: 'json' });
      if (!cur || !cur.data) return false;
      if (now - (cur.data.lastSentAt || 0) < WINDOW) return false;
      const swap = await store.set(key, JSON.stringify({ lastSentAt: now }), { onlyIfMatch: cur.etag });
      return swap.modified;
    };
    const results = await Promise.all(Array.from({ length: 50 }, () => timed(claim)));
    const claimed = results.filter((r) => r.ok && r.value === true).length;
    // expired window: re-run with an old timestamp -> exactly one reclaims
    await store.set(`${key}-old`, JSON.stringify({ lastSentAt: Date.now() - 2 * WINDOW }), { onlyIfNew: true });
    const claimOld = async () => {
      const now = Date.now();
      const cur = await store.getWithMetadata(`${key}-old`, { type: 'json' });
      if (now - (cur.data.lastSentAt || 0) < WINDOW) return false;
      return (await store.set(`${key}-old`, JSON.stringify({ lastSentAt: now }), { onlyIfMatch: cur.etag })).modified;
    };
    const old = await Promise.all(Array.from({ length: 20 }, () => timed(claimOld)));
    rec('T7_global_throttle_pattern', claimed === 1 && old.filter((r) => r.ok && r.value === true).length === 1,
      { freshWindowClaimers: claimed, expiredWindowClaimers: old.filter((r) => r.ok && r.value === true).length, threw: [...results, ...old].filter((r) => !r.ok).length });
  }

  const cleanup = await timed(() => store.deleteAll());
  report.cleanup = cleanup.ok ? cleanup.value : cleanup.error;
  report.summary = Object.fromEntries(Object.entries(report.tests).map(([k, v]) => [k, v.ok]));
  report.allOk = Object.values(report.tests).every((t) => t.ok);
  return json(200, report);
};
