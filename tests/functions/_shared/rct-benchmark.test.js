'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ENV_VAR, PIN_KEY_ENV_VAR, RATIFIED_RCT_HMAC, loadRctBenchmark, validateRctBenchmark, rctTableHmac,
} = require('../../../netlify/functions/_shared/rct-benchmark.js');
const { SYNTHETIC_RCT_ENV_VALUE, syntheticBenchmark } = require('../fixtures/rct-test-env.js');

const good = () => JSON.parse(SYNTHETIC_RCT_ENV_VALUE);
// Schema-only load (the test opt-outs). The production default is pinned; see the pin tests below.
const load = (value) => loadRctBenchmark({ env: value === undefined ? {} : { [ENV_VAR]: value }, allowSynthetic: true, pinnedHmac: null });
const LOCAL_FILE = path.resolve(__dirname, '..', '..', '..', '.rct-benchmark.local.json');
const LOCAL_KEY_FILE = path.resolve(__dirname, '..', '..', '..', '.rct-benchmark-pin-key.local');
const TEST_KEY = 'k'.repeat(40); // test-only key, never the production one

test('the env var names, and the pin is a hex HMAC-SHA256', () => {
  assert.equal(ENV_VAR, 'RCT_BENCHMARK_JSON');
  assert.equal(PIN_KEY_ENV_VAR, 'RCT_BENCHMARK_PIN_KEY');
  assert.match(RATIFIED_RCT_HMAC, /^[0-9a-f]{64}$/);
});

test('the pin is keyed: without the key (missing, blank or short) the production loader fails closed', () => {
  const v = good();
  v.rctVersion = 'replacement-cost.v3.1';
  for (const key of [undefined, '', '   ', 'short-key']) {
    const env = { [ENV_VAR]: JSON.stringify(v) };
    if (key !== undefined) env[PIN_KEY_ENV_VAR] = key;
    const r = loadRctBenchmark({ env });
    assert.equal(r.ok, false);
    assert.match(r.reason, /RCT_BENCHMARK_PIN_KEY is not set/);
  }
});

test('the HMAC depends on the key, so the published pin cannot confirm or brute-force a table without it', () => {
  assert.notEqual(rctTableHmac(good(), TEST_KEY), rctTableHmac(good(), TEST_KEY + 'x'));
  // A pin computed under the right key loads; the same table under another key does not.
  const pinnedHmac = rctTableHmac(good(), TEST_KEY);
  const env = (key) => ({ [ENV_VAR]: SYNTHETIC_RCT_ENV_VALUE, [PIN_KEY_ENV_VAR]: key });
  assert.equal(loadRctBenchmark({ env: env(TEST_KEY), allowSynthetic: true, pinnedHmac }).ok, true);
  assert.match(loadRctBenchmark({ env: env(TEST_KEY + 'x'), allowSynthetic: true, pinnedHmac }).reason, /does not match/);
});

test('a well-formed value loads (schema only), and the result is deeply frozen', () => {
  const r = load(SYNTHETIC_RCT_ENV_VALUE);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.benchmark.marketToRctLowPerSF, syntheticBenchmark.marketToRctLowPerSF);
  assert.ok(Object.isFrozen(r.benchmark) && Object.isFrozen(r.benchmark.marketToRctLowPerSF) && Object.isFrozen(r.benchmark.vintageFloor));
});

test('the production default is pinned: a schema-valid table that is not the ratified one fails closed', () => {
  const v = good();
  v.rctVersion = 'replacement-cost.v3.1'; // looks right, figures are not
  const r = loadRctBenchmark({ env: { [ENV_VAR]: JSON.stringify(v), [PIN_KEY_ENV_VAR]: TEST_KEY } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not match the ratified RCT table/);
  assert.doesNotMatch(r.reason, /[0-9a-f]{16}/, 'the reason must not print the hash either');
});

test('the synthetic fixture is refused by default, by flag OR by version', () => {
  assert.match(loadRctBenchmark({ env: { [ENV_VAR]: JSON.stringify(syntheticBenchmark) }, pinnedHmac: null }).reason, /synthetic test fixture/);
  assert.match(loadRctBenchmark({ env: { [ENV_VAR]: SYNTHETIC_RCT_ENV_VALUE }, pinnedHmac: null }).reason, /synthetic test fixture/, 'flag stripped, version still marks it');
  assert.equal(validateRctBenchmark(syntheticBenchmark, { allowSynthetic: true, pinnedHmac: null }), null);
});

test('reads process.env by default', () => {
  const prev = process.env[ENV_VAR];
  try {
    process.env[ENV_VAR] = SYNTHETIC_RCT_ENV_VALUE;
    assert.equal(loadRctBenchmark({ allowSynthetic: true, pinnedHmac: null }).ok, true);
    delete process.env[ENV_VAR];
    assert.match(loadRctBenchmark().reason, /RCT_BENCHMARK_JSON is not set/);
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR]; else process.env[ENV_VAR] = prev;
  }
});

test('the pin HMAC is order-sensitive and covers every field', () => {
  const base = rctTableHmac(good(), TEST_KEY);
  const mutations = [
    (b) => { b.rctVersion += 'x'; },
    (b) => { const [k] = Object.keys(b.marketToRctLowPerSF); b.marketToRctLowPerSF[k] += 0.01; },
    (b) => { b.marketToRctLowPerSF = Object.fromEntries(Object.entries(b.marketToRctLowPerSF).reverse()); },
    (b) => { b.proxyMarkets = []; },
    (b) => { b.vintageFloor.latePct = 0.49; },
    (b) => { b.vintageFloor.earlyYear = 1991; },
    (b) => { b.marketHints.Columbus = 'Columbus, Ohio'; },
  ];
  for (const m of mutations) { const b = good(); m(b); assert.notEqual(rctTableHmac(b, TEST_KEY), base, m.toString()); }
  assert.equal(rctTableHmac(good(), TEST_KEY), base, 'deterministic');
});

test('the real table and key, when available locally, pass the production loader as-is', (t) => {
  const json = process.env[ENV_VAR] || (fs.existsSync(LOCAL_FILE) ? fs.readFileSync(LOCAL_FILE, 'utf8') : null);
  const key = process.env[PIN_KEY_ENV_VAR] || (fs.existsSync(LOCAL_KEY_FILE) ? fs.readFileSync(LOCAL_KEY_FILE, 'utf8').trim() : null);
  if (!json || !key) { t.skip('no real table + pin key (RCT_BENCHMARK_JSON / RCT_BENCHMARK_PIN_KEY, or the gitignored local files)'); return; }
  const r = loadRctBenchmark({ env: { [ENV_VAR]: json, [PIN_KEY_ENV_VAR]: key } });
  assert.equal(r.ok, true, r.reason);
});

test('fails closed when the variable is missing, blank or not JSON', () => {
  for (const v of [undefined, '', '   ']) {
    const r = load(v);
    assert.equal(r.ok, false);
    assert.match(r.reason, /is not set/);
  }
  for (const v of ['{', 'not json', "{'a':1}"]) assert.match(load(v).reason, /not valid JSON/);
  assert.equal(loadRctBenchmark({ env: null }).ok, false);
});

test('fails closed on every malformed or implausible shape, and the reason never carries a figure', () => {
  const cases = [
    ['null', null],
    ['array', []],
    ['number', 5],
    ['no version', (b) => { delete b.rctVersion; }],
    ['blank version', (b) => { b.rctVersion = ' '; }],
    ['no markets', (b) => { delete b.marketToRctLowPerSF; }],
    ['markets array', (b) => { b.marketToRctLowPerSF = [1, 2]; }],
    ['empty markets', (b) => { b.marketToRctLowPerSF = {}; }],
    ['blank market', (b) => { b.marketToRctLowPerSF[' '] = 100; }],
    ['string value', (b) => { b.marketToRctLowPerSF.Columbus = '200'; }],
    ['zero value', (b) => { b.marketToRctLowPerSF.Columbus = 0; }],
    ['negative value', (b) => { b.marketToRctLowPerSF.Columbus = -1; }],
    ['null value', (b) => { b.marketToRctLowPerSF.Columbus = null; }],
    ['implausibly small value', (b) => { b.marketToRctLowPerSF.Columbus = 2.5; }],
    ['implausibly huge value', (b) => { b.marketToRctLowPerSF.Columbus = 1e300; }],
    ['proxy not list', (b) => { b.proxyMarkets = 'Columbus'; }],
    ['unknown proxy', (b) => { b.proxyMarkets = ['Nowhere']; }],
    ['inherited proxy', (b) => { b.proxyMarkets = ['constructor']; }],
    ['no vintage', (b) => { delete b.vintageFloor; }],
    ['vintage pct 1', (b) => { b.vintageFloor.earlyPct = 1; }],
    ['vintage pct 0', (b) => { b.vintageFloor.latePct = 0; }],
    ['vintage ramp runs the wrong way', (b) => { b.vintageFloor.earlyPct = 0.4; b.vintageFloor.latePct = 0.5; }],
    ['vintage years reversed', (b) => { b.vintageFloor.earlyYear = 2020; }],
    ['vintage year fractional', (b) => { b.vintageFloor.lateYear = 2010.5; }],
    ['vintage years implausible', (b) => { b.vintageFloor.earlyYear = 0; b.vintageFloor.lateYear = 1; }],
    ['vintage pct string', (b) => { b.vintageFloor.earlyPct = '0.6'; }],
    ['hints not object', (b) => { b.marketHints = ['x']; }],
    ['hint for unknown market', (b) => { b.marketHints.Nowhere = 'x'; }],
    ['blank hint', (b) => { b.marketHints.Columbus = ''; }],
  ];
  for (const [name, mutate] of cases) {
    let value;
    if (typeof mutate === 'function') { value = good(); mutate(value); } else value = mutate;
    const r = load(JSON.stringify(value));
    assert.equal(r.ok, false, `${name}: must fail closed`);
    assert.match(r.reason, /^RCT_BENCHMARK_JSON /, name);
    assert.doesNotMatch(r.reason, /\d/, `${name}: reason must carry no figures (${r.reason})`);
  }
});

test('optional fields may be omitted (schema only)', () => {
  const b = good();
  delete b.proxyMarkets;
  delete b.marketHints;
  assert.equal(load(JSON.stringify(b)).ok, true);
});

test('the pin key is trimmed: surrounding whitespace in the env value does not change the HMAC', () => {
  const pinnedHmac = rctTableHmac(good(), TEST_KEY);
  for (const padded of [` ${TEST_KEY}`, `${TEST_KEY}\n`, `\t${TEST_KEY}  \r\n`]) {
    const r = loadRctBenchmark({ env: { [ENV_VAR]: SYNTHETIC_RCT_ENV_VALUE, [PIN_KEY_ENV_VAR]: padded }, allowSynthetic: true, pinnedHmac });
    assert.equal(r.ok, true, r.reason);
  }
});
