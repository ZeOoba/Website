'use strict';
// Test-only helpers around the SYNTHETIC RCT fixture. The real table is governor-level runtime config
// (RCT_BENCHMARK_JSON in the Netlify UI) pinned by hash in rct-benchmark.js; tests never see it. The
// production loader refuses the fixture (synthetic flag/version, and the hash pin), so tests that need a
// loaded benchmark inject `loadSyntheticRct`, which opts out of both through code-only parameters.
const { loadRctBenchmark } = require('../../../netlify/functions/_shared/rct-benchmark.js');
const fixture = require('./rct-benchmark.synthetic.json');

const { _synthetic, _comment, ...schema } = fixture; // eslint-disable-line no-unused-vars
// The fixture minus its marker keys (still carries rctVersion 'synthetic-test-fixture').
const SYNTHETIC_RCT_ENV_VALUE = JSON.stringify(schema);

function loadSyntheticRct() {
  return loadRctBenchmark({ env: { RCT_BENCHMARK_JSON: SYNTHETIC_RCT_ENV_VALUE }, allowSynthetic: true, pinnedHmac: null });
}

module.exports = { SYNTHETIC_RCT_ENV_VALUE, syntheticBenchmark: fixture, loadSyntheticRct };
