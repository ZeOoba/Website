'use strict';

// The RCT replacement-cost floor table (ratified RCT v3.1 LOW $/SF per market, the vintage-floor ramp, the
// proxy-market list and the extractor's market hints) is governor-level data. This repo is PUBLIC, so the
// table is NOT in source: it is read at runtime from the RCT_BENCHMARK_JSON environment variable (set in
// the Netlify UI, Functions scope). Shape and setup: docs/rct-benchmark-config.md.
//
// Fail closed: when the variable is missing, is not JSON, does not match the schema, or is not the RATIFIED
// table, loadRctBenchmark returns { ok: false, reason } and the scoring run withholds the score (status
// 'unavailable', reason 'benchmark_unavailable'). `reason` never carries a figure from the table.
//
// "The ratified table" is pinned by RATIFIED_RCT_HMAC: an HMAC-SHA256 of the whole table in canonical form,
// keyed by a SECOND Functions-scoped env var, RCT_BENCHMARK_PIN_KEY. Keyed on purpose: a plain hash published
// here would let anyone confirm the values in git history, and brute-force a future re-ratification by
// starting from them (round-2 adversarial review, 2026-11-13). Without the key the pin reveals nothing. With
// it, a pasted test value, a typo, a stale version or a hand edit in the Netlify UI all fail closed instead of
// silently moving scores. A missing key also fails closed. Re-ratifying RCT (Hard Invariant 4, Gabriel's
// approval) therefore takes BOTH a new env value and a PR that updates the pin: compute it with rctTableHmac()
// from the gitignored local copies of the table and key (the exact command is in docs/rct-benchmark-config.md).
// Tests load the synthetic fixture with { pinnedHmac: null, allowSynthetic: true }, which only code can pass.

const crypto = require('node:crypto');

const ENV_VAR = 'RCT_BENCHMARK_JSON';
const PIN_KEY_ENV_VAR = 'RCT_BENCHMARK_PIN_KEY';
// replacement-cost.v3.1, copied from rct-benchmark.json at e291dac, every value unchanged (2026-11-13).
const RATIFIED_RCT_HMAC = 'f5df7ed4e5b50943fca7f9c58f6b861cbb614ee81f66fe2a40f84fe4e40f25db';
const PIN_KEY_MIN_LENGTH = 32;
const SYNTHETIC_VERSION = 'synthetic-test-fixture';
// Sanity bounds that apply even to an unpinned (test) table. Not scoring thresholds.
const LOW_PER_SF_MIN = 50;
const LOW_PER_SF_MAX = 1000;
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonBlankString = (s) => typeof s === 'string' && s.trim() !== '';
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Order-sensitive on purpose: market order is the extractor enum order, so it is part of what was ratified.
function rctTableHmac(b, key) {
  const vf = b.vintageFloor || {};
  const canonical = JSON.stringify([
    b.rctVersion,
    Object.entries(b.marketToRctLowPerSF || {}),
    b.proxyMarkets || [],
    [vf.earlyYear, vf.earlyPct, vf.lateYear, vf.latePct],
    Object.entries(b.marketHints || {}),
  ]);
  return crypto.createHmac('sha256', key).update(canonical).digest('hex');
}

function sameHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Same rule as broker-score-engine.js vintageFloorConfigValid, plus plausible years and the ramp direction
// (an older building never gets a smaller discount than a newer one).
function vintageFloorValid(cfg) {
  if (!isPlainObject(cfg)) return false;
  const { earlyYear, lateYear, earlyPct, latePct } = cfg;
  return [earlyYear, lateYear].every((y) => Number.isInteger(y) && y >= YEAR_MIN && y <= YEAR_MAX)
    && earlyYear < lateYear
    && [earlyPct, latePct].every((p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1)
    && earlyPct >= latePct;
}

// Returns null when `b` is a usable benchmark, else a short reason with no figures in it.
function validateRctBenchmark(b, { allowSynthetic = false, pinnedHmac = RATIFIED_RCT_HMAC, pinKey } = {}) {
  if (!isPlainObject(b)) return 'is not a JSON object';
  if ((b._synthetic === true || b.rctVersion === SYNTHETIC_VERSION) && !allowSynthetic) {
    return 'is the synthetic test fixture, not the ratified table';
  }
  if (!isNonBlankString(b.rctVersion)) return 'has no rctVersion';
  const lows = b.marketToRctLowPerSF;
  if (!isPlainObject(lows)) return 'has no marketToRctLowPerSF object';
  const markets = Object.keys(lows);
  if (markets.length === 0) return 'has an empty marketToRctLowPerSF';
  if (!markets.every(isNonBlankString)) return 'has a blank market name';
  if (!markets.every((m) => typeof lows[m] === 'number' && Number.isFinite(lows[m]) && lows[m] >= LOW_PER_SF_MIN && lows[m] <= LOW_PER_SF_MAX)) {
    return 'has a market whose LOW $/SF is not a number in the plausible range';
  }
  if (b.proxyMarkets !== undefined) {
    if (!Array.isArray(b.proxyMarkets)) return 'has a proxyMarkets that is not a list';
    if (!b.proxyMarkets.every((m) => typeof m === 'string' && hasOwn(lows, m))) {
      return 'lists a proxy market that is not in marketToRctLowPerSF';
    }
  }
  if (!vintageFloorValid(b.vintageFloor)) return 'has an invalid vintageFloor';
  if (b.marketHints !== undefined) {
    if (!isPlainObject(b.marketHints)) return 'has a marketHints that is not an object';
    for (const [m, hint] of Object.entries(b.marketHints)) {
      if (!hasOwn(lows, m)) return 'has a market hint for a market that is not in marketToRctLowPerSF';
      if (!isNonBlankString(hint)) return 'has a blank market hint';
    }
  }
  if (pinnedHmac) {
    if (typeof pinKey !== 'string' || pinKey.trim().length < PIN_KEY_MIN_LENGTH) {
      return `cannot be checked: ${PIN_KEY_ENV_VAR} is not set (or too short)`;
    }
    if (!sameHex(rctTableHmac(b, pinKey.trim()), pinnedHmac)) {
      return 'does not match the ratified RCT table pinned in rct-benchmark.js (re-ratification needs a code change too)';
    }
  }
  return null;
}

function deepFreeze(o) {
  Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

// Read per call (one small JSON.parse), so there is no module-level copy to go stale.
function loadRctBenchmark({ env = process.env, allowSynthetic = false, pinnedHmac = RATIFIED_RCT_HMAC } = {}) {
  const raw = env ? env[ENV_VAR] : undefined;
  if (!isNonBlankString(raw)) return { ok: false, reason: `${ENV_VAR} is not set` };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${ENV_VAR} is not valid JSON` };
  }
  const bad = validateRctBenchmark(parsed, { allowSynthetic, pinnedHmac, pinKey: env[PIN_KEY_ENV_VAR] });
  if (bad) return { ok: false, reason: `${ENV_VAR} ${bad}` };
  return { ok: true, benchmark: deepFreeze(parsed) };
}

module.exports = { ENV_VAR, PIN_KEY_ENV_VAR, RATIFIED_RCT_HMAC, loadRctBenchmark, validateRctBenchmark, rctTableHmac };
