'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { vintageFloorPct } = require('../../../netlify/functions/_shared/broker-score-engine.js');
const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');

// The real RCT table (LOW $/SF and vintage ramp) is governor-level and lives only in the RCT_BENCHMARK_JSON
// env var; these tests run against the SYNTHETIC fixture (ramp 1990 @ 0.60 -> 2010 @ 0.50), never real figures.
test('the benchmark used by tests is the synthetic fixture, never the ratified table', () => {
  assert.equal(rctBenchmark._synthetic, true);
  assert.equal(rctBenchmark.rctVersion, 'synthetic-test-fixture');
});

test('vintageFloorPct returns the early pct for a building built at or before earlyYear', () => {
  assert.equal(vintageFloorPct(1990, rctBenchmark.vintageFloor), 0.60);
  assert.equal(vintageFloorPct(1980, rctBenchmark.vintageFloor), 0.60);
});

test('vintageFloorPct returns the late pct for a building built in or after lateYear', () => {
  assert.equal(vintageFloorPct(2010, rctBenchmark.vintageFloor), 0.50);
  assert.equal(vintageFloorPct(2024, rctBenchmark.vintageFloor), 0.50);
});

test('vintageFloorPct interpolates linearly between earlyYear and lateYear', () => {
  assert.ok(Math.abs(vintageFloorPct(2000, rctBenchmark.vintageFloor) - 0.55) < 1e-12);
});

test('vintageFloorPct defaults to the conservative early floor when year built is missing', () => {
  assert.equal(vintageFloorPct(null, rctBenchmark.vintageFloor), 0.60);
  assert.equal(vintageFloorPct(undefined, rctBenchmark.vintageFloor), 0.60);
});

const { evaluatePropertyTypeGate, evaluateMarketGate } = require('../../../netlify/functions/_shared/broker-score-engine.js');

test('evaluatePropertyTypeGate PASSes for every in-box asset class', () => {
  for (const ac of ['industrial', 'flex', 'shallow_bay', 'ios']) {
    assert.equal(evaluatePropertyTypeGate(ac), 'PASS');
  }
});

test('evaluatePropertyTypeGate FAILs for a fundamentally different asset class', () => {
  for (const ac of ['multifamily', 'retail', 'office', 'hospitality', 'land', 'other']) {
    assert.equal(evaluatePropertyTypeGate(ac), 'FAIL');
  }
});

test('evaluatePropertyTypeGate is NOT_VERIFIED when asset class is not stated', () => {
  assert.equal(evaluatePropertyTypeGate(null), 'NOT_VERIFIED');
  assert.equal(evaluatePropertyTypeGate(undefined), 'NOT_VERIFIED');
});

test('evaluateMarketGate PASSes when the LLM matched one of the RCT benchmark markets', () => {
  assert.equal(evaluateMarketGate('Columbus', 'Columbus', 'OH'), 'PASS');
});

test('evaluateMarketGate FAILs when a location was extracted but matches no target market', () => {
  assert.equal(evaluateMarketGate(null, 'Phoenix', 'AZ'), 'FAIL');
});

test('evaluateMarketGate is NOT_VERIFIED when no location was extracted at all', () => {
  assert.equal(evaluateMarketGate(null, null, null), 'NOT_VERIFIED');
});

const { scoreDealSize, scoreBuildingSize, scoreClearHeight, scoreBasis } = require('../../../netlify/functions/_shared/broker-score-engine.js');

test('scoreDealSize gives full credit inside $1M-$10M', () => {
  const r = scoreDealSize(5_000_000);
  assert.equal(r.possible, 25);
  assert.equal(r.earned, 25);
});

test('scoreDealSize tapers to zero at $500K and below', () => {
  assert.equal(scoreDealSize(500_000).earned, 0);
  assert.equal(scoreDealSize(750_000).earned, 13); // roughly half credit at the midpoint
});

test('scoreDealSize tapers to zero at $15M and above', () => {
  assert.equal(scoreDealSize(15_000_000).earned, 0);
  assert.equal(scoreDealSize(20_000_000).earned, 0);
});

test('scoreDealSize is excluded when asking price is not stated', () => {
  const r = scoreDealSize(null);
  assert.equal(r.excluded, true);
  assert.equal(r.earned, undefined);
});

test('scoreBuildingSize gives full credit under 50,000 SF and tapers to zero by 100,000 SF', () => {
  assert.equal(scoreBuildingSize(30_000).earned, 20);
  assert.equal(scoreBuildingSize(75_000).earned, 10);
  assert.equal(scoreBuildingSize(100_000).earned, 0);
  assert.equal(scoreBuildingSize(150_000).earned, 0);
});

test('scoreClearHeight gives full credit at 18ft+, tapers 14-18, zero below 14', () => {
  assert.equal(scoreClearHeight(20).earned, 15);
  assert.equal(scoreClearHeight(16).earned, 8); // midpoint of the 14-18 taper
  assert.equal(scoreClearHeight(10).earned, 0);
});

test('scoreBasis gives full credit when priced comfortably below the RCT v03 floor', () => {
  const rctBenchmark = { marketToRctLowPerSF: { 'Columbus': 200 }, vintageFloor: { earlyYear: 1990, earlyPct: 0.60, lateYear: 2010, latePct: 0.50 } };
  // synthetic: floor = 200 * (1 - 0.60) = 80; comfortable = floor * 0.85 = 68
  const r = scoreBasis(2_000_000, 40_000, 1990, 'Columbus', rctBenchmark);
  assert.equal(r.possible, 25);
  assert.equal(r.earned, 25); // implied $/SF = 2,040,000/40,000 = $51 — well under $68
});

test('scoreBasis gives zero when priced above the RCT v03 floor', () => {
  const rctBenchmark = { marketToRctLowPerSF: { 'Columbus': 200 }, vintageFloor: { earlyYear: 1990, earlyPct: 0.60, lateYear: 2010, latePct: 0.50 } };
  const r = scoreBasis(4_000_000, 40_000, 1990, 'Columbus', rctBenchmark);
  assert.equal(r.earned, 0); // implied $/SF = 4,080,000/40,000 = $102 — over the $80 floor
});

test('scoreBasis is excluded when asking price, size, or matched market is missing', () => {
  const rctBenchmark = { marketToRctLowPerSF: { 'Columbus': 200 }, vintageFloor: { earlyYear: 1990, earlyPct: 0.60, lateYear: 2010, latePct: 0.50 } };
  assert.equal(scoreBasis(null, 40_000, 1990, 'Columbus', rctBenchmark).excluded, true);
  assert.equal(scoreBasis(2_000_000, null, 1990, 'Columbus', rctBenchmark).excluded, true);
  assert.equal(scoreBasis(2_000_000, 40_000, 1990, null, rctBenchmark).excluded, true);
});

const { scoreComplexity, scoreDeal } = require('../../../netlify/functions/_shared/broker-score-engine.js');

test('scoreComplexity gives full credit for 2+ value-add signals', () => {
  const r = scoreComplexity(['vacancy', 'deferred_maintenance']);
  assert.equal(r.earned, 15);
});

test('scoreComplexity gives half credit for exactly one signal', () => {
  assert.equal(scoreComplexity(['vacancy']).earned, 8);
});

test('scoreComplexity gives zero for a fully stabilized, turnkey asset', () => {
  assert.equal(scoreComplexity(['none_stabilized']).earned, 0);
});

test('scoreComplexity is excluded when no signals were extracted at all', () => {
  assert.equal(scoreComplexity([]).excluded, true);
  assert.equal(scoreComplexity(null).excluded, true);
});

test('scoreDeal: a clean in-box Columbus deal scores high with both gates PASS', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const extracted = {
    askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'industrial', buildingGrade: 'B',
    clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
    valueAddSignals: ['vacancy', 'deferred_maintenance'], notes: null,
  };
  const result = scoreDeal(extracted, rctBenchmark);
  assert.equal(result.gates.propertyType, 'PASS');
  assert.equal(result.gates.market, 'PASS');
  assert.equal(result.gateFailed, false);
  assert.ok(result.finalScore >= 90, `expected a high score, got ${result.finalScore}`);
  assert.equal(result.categories.length, 5);
});

test('scoreDeal: a multifamily deal in a target city still gets capped at <=30 by the property-type gate', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const extracted = {
    askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'multifamily', buildingGrade: 'B',
    clearHeightFt: null, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
    valueAddSignals: ['vacancy', 'deferred_maintenance'], notes: null,
  };
  const result = scoreDeal(extracted, rctBenchmark);
  assert.equal(result.gates.propertyType, 'FAIL');
  assert.equal(result.gateFailed, true);
  assert.ok(result.finalScore <= 30, `expected a capped score, got ${result.finalScore}`);
});

test('scoreDeal: a Class A industrial building passes the property-type gate normally (grade does not gate)', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const extracted = {
    askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'industrial', buildingGrade: 'A',
    clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 2010,
    valueAddSignals: ['none_stabilized'], notes: null,
  };
  const result = scoreDeal(extracted, rctBenchmark);
  assert.equal(result.gates.propertyType, 'PASS');
  assert.equal(result.gateFailed, false);
});

test('scoreDeal: a rent-roll-only submission with no price/type/location re-normalizes around what IS known', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const extracted = {
    askingPrice: null, buildingSizeSF: 30_000, assetClass: null, buildingGrade: null,
    clearHeightFt: 20, city: null, state: null, matchedRctMarket: null, yearBuilt: null,
    valueAddSignals: [], notes: 'Rent roll only, no asking price stated.',
  };
  const result = scoreDeal(extracted, rctBenchmark);
  assert.equal(result.gates.propertyType, 'NOT_VERIFIED');
  assert.equal(result.gates.market, 'NOT_VERIFIED');
  assert.equal(result.gateFailed, false); // NOT_VERIFIED never caps the score
  const buildingSizeCat = result.categories.find((c) => c.key === 'buildingSize');
  assert.equal(buildingSizeCat.excluded, false);
  const dealSizeCat = result.categories.find((c) => c.key === 'dealSize');
  assert.equal(dealSizeCat.excluded, true);
});

// 2026-09-30 audit (oxfordra.net items 3 and 4).
test('scoreDeal: the broker-facing basis note never discloses the replacement-cost floor in dollars', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const over = scoreDeal({
    askingPrice: 4_000_000, buildingSizeSF: 10_000, assetClass: 'industrial', buildingGrade: 'B',
    clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
    valueAddSignals: ['vacancy'], notes: null,
  }, rctBenchmark);
  const basis = over.categories.find((c) => c.key === 'basis');
  assert.equal(basis.earned, 0);
  assert.doesNotMatch(basis.note, /\$\d|\/SF/, 'public note must carry no dollar figures or $/SF');
  assert.match(basis.internalNote, /floor of \$\d/, 'the internal note keeps the figure for Gabriel and Eric');
  for (const price of [1_500_000, 2_400_000]) {
    const r = scoreDeal({
      askingPrice: price, buildingSizeSF: 10_000, assetClass: 'industrial', buildingGrade: 'B',
      clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
      valueAddSignals: ['vacancy'], notes: null,
    }, rctBenchmark);
    const b = r.categories.find((c) => c.key === 'basis');
    assert.doesNotMatch(b.note, /\$\d|\/SF/);
  }
});

test('scoreDeal: a complete extraction reports full coverage and a numeric score', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const r = scoreDeal({
    askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'industrial', buildingGrade: 'B',
    clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
    valueAddSignals: ['vacancy', 'deferred_maintenance'], notes: null,
  }, rctBenchmark);
  assert.equal(r.coveragePct, 100);
  assert.equal(r.insufficientData, false);
  assert.equal(typeof r.finalScore, 'number');
});

test('scoreDeal: a near-empty extraction withholds the score instead of printing 100/100', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const r = scoreDeal({
    askingPrice: null, buildingSizeSF: 30_000, assetClass: null, buildingGrade: null,
    clearHeightFt: 20, city: null, state: null, matchedRctMarket: null, yearBuilt: null,
    valueAddSignals: [], notes: 'Rent roll only, no asking price stated.',
  }, rctBenchmark);
  assert.equal(r.coveragePct, 35);
  assert.equal(r.insufficientData, true);
  assert.equal(r.finalScore, null);
});

test('scoreDeal: a fully empty extraction is insufficient data, not a verified zero', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const r = scoreDeal({
    askingPrice: null, buildingSizeSF: null, assetClass: null, buildingGrade: null,
    clearHeightFt: null, city: null, state: null, matchedRctMarket: null, yearBuilt: null,
    valueAddSignals: [], notes: null,
  }, rctBenchmark);
  assert.equal(r.coveragePct, 0);
  assert.equal(r.insufficientData, true);
  assert.equal(r.finalScore, null);
});

test('scoreDeal: a verified gate failure keeps its capped numeric score even on thin data', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const r = scoreDeal({
    askingPrice: null, buildingSizeSF: 40_000, assetClass: 'multifamily', buildingGrade: null,
    clearHeightFt: null, city: null, state: null, matchedRctMarket: null, yearBuilt: null,
    valueAddSignals: [], notes: null,
  }, rctBenchmark);
  assert.equal(r.gateFailed, true);
  assert.equal(r.insufficientData, false);
  assert.equal(typeof r.finalScore, 'number');
  assert.ok(r.finalScore <= 30);
});

// Pins the coverage boundary: dealSize (25) + buildingSize (20) + clearHeight (15) = exactly 60, which
// must be scored; dealSize + buildingSize = 45 must be withheld. A flipped comparison would pass the
// other tests (independent review, 2026-09-30).
test('scoreDeal: exactly 60% coverage is scored, 45% is withheld', () => {
  const rctBenchmark = require('../fixtures/rct-benchmark.synthetic.json');
  const base = { assetClass: 'industrial', buildingGrade: 'B', city: null, state: null, matchedRctMarket: null, yearBuilt: null, valueAddSignals: [], notes: null };
  const at60 = scoreDeal({ ...base, askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: 20 }, rctBenchmark);
  assert.equal(at60.coveragePct, 60);
  assert.equal(at60.insufficientData, false);
  assert.equal(typeof at60.finalScore, 'number');
  const at45 = scoreDeal({ ...base, askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: null }, rctBenchmark);
  assert.equal(at45.coveragePct, 45);
  assert.equal(at45.insufficientData, true);
  assert.equal(at45.finalScore, null);
});

// Independent review 2026-10-01 (F1): the no-dollars test only exercised the above-floor outcome, so
// the floor could be put back in the other two broker notes without any test failing. Derive prices
// from the floor so each of the three outcomes is actually hit.
test('scoreDeal: the broker-facing basis note carries no dollar figures in ANY of the three outcomes', () => {
  const { scoreDeal } = require('../../../netlify/functions/_shared/broker-score-engine.js');
  const rctLow = rctBenchmark.marketToRctLowPerSF.Columbus;
  const floorPerSF = rctLow * (1 - vintageFloorPct(1990, rctBenchmark.vintageFloor));
  const sf = 10_000;
  const askFor = (perSF) => Math.round((perSF * sf) / 1.02);
  const basisFor = (perSF) => scoreDeal({
    askingPrice: askFor(perSF), buildingSizeSF: sf, assetClass: 'industrial', buildingGrade: 'B',
    clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
    valueAddSignals: ['vacancy'], notes: null,
  }, rctBenchmark).categories.find((c) => c.key === 'basis');

  const full = basisFor(floorPerSF * 0.8);
  const partial = basisFor(floorPerSF * 0.92);
  const over = basisFor(floorPerSF * 1.1);
  assert.equal(full.earned, 25, 'price 20% under the floor must earn full credit');
  assert.ok(partial.earned > 0 && partial.earned < 25, `price 8% under the floor must earn partial credit, got ${partial.earned}`);
  assert.equal(over.earned, 0, 'price 10% over the floor must earn nothing');
  for (const [name, cat] of [['full', full], ['partial', partial], ['over', over]]) {
    // No digits at all: a bare number such as the floor without a $ or /SF must not slip through either
    // (independent review 2026-10-01: a bare-number leak passed the earlier $-only pattern).
    assert.doesNotMatch(cat.note, /\d/, `${name}: public note must carry no figures at all`);
    assert.match(cat.internalNote, /\$\d/, `${name}: the internal note keeps the figures for Gabriel and Eric`);
  }
});

// Independent review 2026-10-01 (F2): the threshold was only pinned at 45 and 60, so any value from 46
// to 60 passed. 55% (dealSize 25 + clearHeight 15 + complexity 15) must be withheld.
test('scoreDeal: 55% coverage is withheld, so the threshold cannot drift below 60 unnoticed', () => {
  const { scoreDeal } = require('../../../netlify/functions/_shared/broker-score-engine.js');
  const r = scoreDeal({
    askingPrice: 2_000_000, buildingSizeSF: null, assetClass: 'industrial', buildingGrade: 'B',
    clearHeightFt: 20, city: null, state: null, matchedRctMarket: null, yearBuilt: null,
    valueAddSignals: ['vacancy', 'deferred_maintenance'], notes: null,
  }, rctBenchmark);
  assert.equal(r.coveragePct, 55);
  assert.equal(r.insufficientData, true);
  assert.equal(r.finalScore, null);
});

// Market gate extension (2026-10-01): every market in the benchmark must pass the gate and be scored.
// The ratified market list and its figures are runtime config (RCT_BENCHMARK_JSON) and are not pinned here;
// the fixture exercises the same shape (direct and proxy markets).
test('the synthetic fixture has the production schema: direct and proxy markets, hints, a vintage ramp', () => {
  const { validateRctBenchmark } = require('../../../netlify/functions/_shared/rct-benchmark.js');
  assert.equal(validateRctBenchmark(rctBenchmark, { allowSynthetic: true, pinnedHmac: null }), null);
  assert.ok(Object.keys(rctBenchmark.marketToRctLowPerSF).length >= 3);
  assert.ok(rctBenchmark.proxyMarkets.length >= 1);
});

test('the extractor enum is derived from the benchmark keys, so the two can never drift apart', () => {
  const { buildExtractionTool } = require('../../../netlify/functions/_shared/broker-llm-extract.js');
  const EXTRACTION_TOOL = buildExtractionTool(rctBenchmark);
  const en = EXTRACTION_TOOL.input_schema.properties.matchedRctMarket.enum;
  assert.deepEqual(en.filter((x) => x !== null).sort(), Object.keys(rctBenchmark.marketToRctLowPerSF).sort());
  assert.ok(en.includes(null), 'null must stay valid for an unmatched market');
  const desc = EXTRACTION_TOOL.input_schema.properties.matchedRctMarket.description;
  for (const m of Object.keys(rctBenchmark.marketToRctLowPerSF)) assert.ok(desc.includes(m), `description must name ${m}`);
  assert.doesNotMatch(desc, /\bfour\b/i, 'the description must not hard-code a market count');
});

test('every benchmark market passes the gate and gets a basis score instead of the 30 cap', () => {
  const { scoreDeal } = require('../../../netlify/functions/_shared/broker-score-engine.js');
  for (const [market, low] of Object.entries(rctBenchmark.marketToRctLowPerSF)) {
    // The floor is (1 - vintage pct) of the market's replacement cost LOW; price at half of it so the
    // basis category earns full credit in every market whatever its figure is.
    const floorPerSF = low * (1 - vintageFloorPct(1990, rctBenchmark.vintageFloor));
    const sf = 10_000;
    const r = scoreDeal({
      askingPrice: Math.round((0.5 * floorPerSF * sf) / 1.02), buildingSizeSF: sf, assetClass: 'industrial', buildingGrade: 'B',
      clearHeightFt: 20, city: market, state: 'XX', matchedRctMarket: market, yearBuilt: 1990,
      valueAddSignals: ['vacancy'], notes: null,
    }, rctBenchmark);
    assert.equal(r.gates.market, 'PASS', `${market}: market gate`);
    assert.equal(r.gateFailed, false, `${market}: must not be capped`);
    const basis = r.categories.find((c) => c.key === 'basis');
    assert.equal(basis.excluded, false, `${market}: basis must be computed`);
    assert.equal(basis.earned, 25, `${market}: a price at half the floor earns full basis credit`);
  }
});

test('a proxy benchmark market is flagged in the internal note only, never in the public note', () => {
  const { scoreDeal } = require('../../../netlify/functions/_shared/broker-score-engine.js');
  assert.ok(Array.isArray(rctBenchmark.proxyMarkets) && rctBenchmark.proxyMarkets.length > 0);
  const deal = (market) => scoreDeal({
    askingPrice: 1_500_000, buildingSizeSF: 10_000, assetClass: 'industrial', buildingGrade: 'B',
    clearHeightFt: 20, city: market, state: 'XX', matchedRctMarket: market, yearBuilt: 1990,
    valueAddSignals: ['vacancy'], notes: null,
  }, rctBenchmark).categories.find((c) => c.key === 'basis');
  for (const m of rctBenchmark.proxyMarkets) {
    assert.match(deal(m).internalNote, /proxy/i, `${m}: internal note must say the benchmark is a proxy`);
    assert.doesNotMatch(deal(m).note, /proxy/i, `${m}: public note must not`);
  }
  assert.doesNotMatch(deal('Columbus').internalNote, /proxy/i, 'a directly sourced market is not flagged');
});

// Independent review 2026-10-01, F1: the proxy test only exercised the above-floor branch, so a leak of
// "proxy" into the public note, or drift of the proxy list, in the other two outcomes passed. Sweep all
// three outcomes for every market and pin the proxy list to the engine's ratified flags.
test('proxy markets are pinned to the fixture list and never leak into a public note in ANY outcome', () => {
  const { scoreDeal } = require('../../../netlify/functions/_shared/broker-score-engine.js');
  assert.deepEqual([...rctBenchmark.proxyMarkets].sort(), ['Synthetic Proxy B']);
  for (const [market, low] of Object.entries(rctBenchmark.marketToRctLowPerSF)) {
    const floorPerSF = low * (1 - vintageFloorPct(1990, rctBenchmark.vintageFloor));
    const sf = 10_000;
    for (const mult of [0.8, 0.92, 1.1]) {
      const basis = scoreDeal({
        askingPrice: Math.round((mult * floorPerSF * sf) / 1.02), buildingSizeSF: sf, assetClass: 'industrial', buildingGrade: 'B',
        clearHeightFt: 20, city: market, state: 'XX', matchedRctMarket: market, yearBuilt: 1990,
        valueAddSignals: ['vacancy'], notes: null,
      }, rctBenchmark).categories.find((c) => c.key === 'basis');
      assert.doesNotMatch(basis.note, /proxy|\d/i, `${market} x${mult}: public note must carry neither "proxy" nor a digit`);
      const isProxy = rctBenchmark.proxyMarkets.includes(market);
      assert.equal(/proxy/i.test(basis.internalNote), isProxy, `${market} x${mult}: internal note proxy flag must be ${isProxy}`);
    }
  }
});

// Independent review 2026-10-01, F2 (pre-existing hole): evaluateMarketGate passed ANY non-empty string,
// so an LLM answer outside the enum (for example "Phoenix") got a gate PASS and an uncapped score. The
// engine now treats a market that is not a benchmark key as unmatched.
test('a matchedRctMarket that is not a benchmark market is treated as unmatched, so the gate still fails and caps', () => {
  const { scoreDeal } = require('../../../netlify/functions/_shared/broker-score-engine.js');
  const base = {
    askingPrice: 1_000_000, buildingSizeSF: 20_000, assetClass: 'industrial', buildingGrade: 'B',
    clearHeightFt: 20, yearBuilt: 1990, valueAddSignals: ['vacancy', 'deferred_maintenance'], notes: null,
  };
  const phoenix = scoreDeal({ ...base, city: 'Phoenix', state: 'AZ', matchedRctMarket: 'Phoenix' }, rctBenchmark);
  assert.equal(phoenix.gates.market, 'FAIL');
  assert.equal(phoenix.gateFailed, true);
  assert.ok(phoenix.finalScore <= 30, `expected the 30 cap, got ${phoenix.finalScore}`);
  assert.equal(phoenix.categories.find((c) => c.key === 'basis').excluded, true, 'no benchmark, so basis is excluded');
  const noLocation = scoreDeal({ ...base, city: null, state: null, matchedRctMarket: 'Phoenix' }, rctBenchmark);
  assert.equal(noLocation.gates.market, 'NOT_VERIFIED');
  assert.equal(noLocation.gateFailed, false);
  const hit = scoreDeal({ ...base, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus' }, rctBenchmark);
  assert.equal(hit.gates.market, 'PASS');
  const inherited = scoreDeal({ ...base, city: 'X', state: 'Y', matchedRctMarket: 'constructor' }, rctBenchmark);
  assert.equal(inherited.gates.market, 'FAIL', 'prototype keys must not count as markets');
  // scoreBasis must also see the guarded value, else an inherited function leaks in and the score goes NaN.
  assert.equal(inherited.categories.find((c) => c.key === 'basis').excluded, true);
  assert.ok(Number.isFinite(inherited.finalScore));
});

// Input validation and boundary labels (broker score hardening). The extractor is an LLM: a 0, a string, a
// wrong-unit figure or an absurd magnitude must withhold the score for review, never earn credit or go NaN.
const engine = require('../../../netlify/functions/_shared/broker-score-engine.js');

const goodDeal = {
  askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'industrial', buildingGrade: 'B',
  clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
  valueAddSignals: ['vacancy', 'deferred_maintenance'], notes: null,
};

function assertNoNaN(value, path = 'result') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (Array.isArray(value)) value.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
}

test('plausibility bounds are exported named constants', () => {
  assert.equal(engine.PLAUSIBLE_ASKING_PRICE_MIN, 50_000);
  assert.equal(engine.PLAUSIBLE_BUILDING_SF_MIN, 500);
  assert.ok(engine.PLAUSIBLE_PRICE_PER_SF_MAX > engine.PLAUSIBLE_PRICE_PER_SF_MIN);
});

const BAD_VALUES = [
  ['zero', 0], ['negative', -5_000_000], ['NaN', NaN], ['Infinity', Infinity],
  ['string-numeric', '5000000'], ['string with $', '$5M'], ['boolean', true], ['object', {}],
];

for (const [label, bad] of BAD_VALUES) {
  test(`scoreDeal: asking price ${label} needs review, no score, no NaN`, () => {
    const r = engine.scoreDeal({ ...goodDeal, askingPrice: bad }, rctBenchmark);
    assert.equal(r.needsReview, true);
    assert.equal(r.finalScore, null);
    assert.equal(r.insufficientData, true);
    assert.ok(r.reviewReasons.length >= 1);
    assertNoNaN(r);
    assert.doesNotMatch(r.categories.find((c) => c.key === 'dealSize').note, /\d/, 'public note carries no figures');
  });
  test(`scoreDeal: building SF ${label} needs review, no score, no NaN`, () => {
    const r = engine.scoreDeal({ ...goodDeal, buildingSizeSF: bad }, rctBenchmark);
    assert.equal(r.needsReview, true);
    assert.equal(r.finalScore, null);
    assertNoNaN(r);
  });
  test(`scoreDeal: clear height ${label} needs review, no score, no NaN`, () => {
    const r = engine.scoreDeal({ ...goodDeal, clearHeightFt: bad }, rctBenchmark);
    assert.equal(r.needsReview, true);
    assert.equal(r.finalScore, null);
    assertNoNaN(r);
  });
}

test('scoreDeal: price 0 and SF 0 together (0/0) is needs review, never NaN', () => {
  const r = engine.scoreDeal({ ...goodDeal, askingPrice: 0, buildingSizeSF: 0 }, rctBenchmark);
  assert.equal(r.needsReview, true);
  assert.equal(r.finalScore, null);
  assertNoNaN(r);
  assert.equal(engine.scoreBasis(0, 0, 1990, 'Columbus', rctBenchmark).invalid, true);
});

test('scoreBasis: price 0 no longer earns full basis credit', () => {
  const basis = engine.scoreBasis(0, 40_000, 1990, 'Columbus', rctBenchmark);
  assert.equal(basis.excluded, true);
  assert.equal(basis.earned, undefined);
  assert.equal(basis.invalid, true);
});

test('scoreDeal: absurd magnitudes (wrong unit) need review', () => {
  for (const patch of [
    { askingPrice: 2_000 }, { buildingSizeSF: 40 }, { askingPrice: 9e15 }, { buildingSizeSF: 9e12 }, { clearHeightFt: 2000 },
  ]) {
    const r = engine.scoreDeal({ ...goodDeal, ...patch }, rctBenchmark);
    assert.equal(r.needsReview, true, JSON.stringify(patch));
    assert.equal(r.finalScore, null);
    assertNoNaN(r);
  }
});

test('scoreDeal: each figure plausible alone but implied $/SF implausible needs review', () => {
  const r = engine.scoreDeal({ ...goodDeal, askingPrice: 5_000_000, buildingSizeSF: 600 }, rctBenchmark);
  assert.equal(r.needsReview, true);
  assert.equal(r.categories.find((c) => c.key === 'basis').excluded, true);
  const cheap = engine.scoreDeal({ ...goodDeal, askingPrice: 60_000, buildingSizeSF: 4_000_000 }, rctBenchmark);
  assert.equal(cheap.needsReview, true);
});

test('scoreDeal: implausible implied $/SF needs review even when no RCT market matched', () => {
  // Basis is excluded when no market matched, so the basis category cannot be the only place this is caught.
  for (const matchedRctMarket of [null, undefined, 'Phoenix']) {
    const r = engine.scoreDeal({ ...goodDeal, askingPrice: 5_000_000, buildingSizeSF: 600, matchedRctMarket }, rctBenchmark);
    assert.equal(r.needsReview, true, String(matchedRctMarket));
    assert.equal(r.finalScore, null, String(matchedRctMarket));
    assert.ok(r.reviewReasons.some((x) => /price per SF/i.test(x)), String(matchedRctMarket));
  }
  // A plausible ratio with no market is still just an excluded basis, not a review.
  const ok = engine.scoreDeal({ ...goodDeal, matchedRctMarket: null }, rctBenchmark);
  assert.equal(ok.needsReview, false);
});

test('scoreDeal: review reasons are not duplicated across categories', () => {
  const r = engine.scoreDeal({ ...goodDeal, askingPrice: 0 }, rctBenchmark);
  assert.equal(r.needsReview, true);
  assert.equal(new Set(r.reviewReasons).size, r.reviewReasons.length, JSON.stringify(r.reviewReasons));
});

test('scoreBasis: a matched market with a non-numeric / non-positive benchmark needs review, not silent exclusion', () => {
  for (const bad of ['229', NaN, -5, 0]) {
    const bench = { ...rctBenchmark, marketToRctLowPerSF: { ...rctBenchmark.marketToRctLowPerSF, Columbus: bad } };
    const r = engine.scoreDeal({ ...goodDeal, matchedRctMarket: 'Columbus' }, bench);
    assert.equal(r.needsReview, true, String(bad));
    assert.equal(r.finalScore, null, String(bad));
  }
});

test('scoreClearHeight: exactly 14 ft earns 0 and is labelled as the floor, not as tapering credit', () => {
  const at = engine.scoreClearHeight(14);
  assert.equal(at.earned, 0);
  assert.doesNotMatch(at.note, /tapering credit/);
  assert.match(engine.scoreClearHeight(16).note, /tapering credit/);
});

test('scoreDeal: an invalid figure does not exempt a gate failure from review', () => {
  const r = engine.scoreDeal({ ...goodDeal, assetClass: 'multifamily', askingPrice: 0 }, rctBenchmark);
  assert.equal(r.gateFailed, true);
  assert.equal(r.needsReview, true);
  assert.equal(r.finalScore, null);
});

test('scoreDeal: missing (null/undefined) figures stay excluded, not flagged', () => {
  const r = engine.scoreDeal({ ...goodDeal, clearHeightFt: undefined, askingPrice: null }, rctBenchmark);
  assert.equal(r.needsReview, false);
  assert.deepEqual(r.reviewReasons, []);
  assertNoNaN(r);
});

test('scoreDeal: a clean deal is unchanged (needsReview false, same score)', () => {
  const r = engine.scoreDeal(goodDeal, rctBenchmark);
  assert.equal(r.needsReview, false);
  assert.equal(r.insufficientData, false);
  assert.ok(r.finalScore >= 90);
  assertNoNaN(r);
});

test('scoreDeal: a non-array valueAddSignals fails closed to review (the original engine threw, failing closed to unavailable)', () => {
  for (const shape of ['vacancy', 'vacancy,legal_issue', { 0: 'vacancy', length: 1 }, {}, 5, true, new String('vacancy'), '', 0, false, { length: 0 }]) {
    const r = engine.scoreDeal({ ...goodDeal, valueAddSignals: shape }, rctBenchmark);
    assert.equal(r.needsReview, true, JSON.stringify(shape));
    assert.equal(r.finalScore, null);
    assert.match(r.reviewReasons.join(' '), /Value-add signals is not a list/);
    assertNoNaN(r);
  }
});

test('scoreDeal: null/undefined/empty valueAddSignals stay "not stated" (excluded, no review)', () => {
  for (const v of [null, undefined, []]) {
    const r = engine.scoreDeal({ ...goodDeal, valueAddSignals: v }, rctBenchmark);
    assert.equal(r.needsReview, false);
    assert.equal(r.categories.find((c) => c.key === 'complexity').excluded, true);
  }
});

test('plausibility bounds are inclusive: values exactly at each limit are accepted', () => {
  assert.equal(engine.scoreDealSize(engine.PLAUSIBLE_ASKING_PRICE_MIN).invalid, undefined);
  assert.equal(engine.scoreDealSize(engine.PLAUSIBLE_ASKING_PRICE_MAX).invalid, undefined);
  assert.equal(engine.scoreBuildingSize(engine.PLAUSIBLE_BUILDING_SF_MIN).invalid, undefined);
  assert.equal(engine.scoreBuildingSize(engine.PLAUSIBLE_BUILDING_SF_MAX).invalid, undefined);
  assert.equal(engine.scoreClearHeight(engine.PLAUSIBLE_CLEAR_HEIGHT_MIN_FT).invalid, undefined);
  assert.equal(engine.scoreClearHeight(engine.PLAUSIBLE_CLEAR_HEIGHT_MAX_FT).invalid, undefined);
  assert.equal(engine.scoreDealSize(engine.PLAUSIBLE_ASKING_PRICE_MIN - 1).invalid, true);
  assert.equal(engine.scoreBuildingSize(engine.PLAUSIBLE_BUILDING_SF_MIN - 1).invalid, true);
});

// Boundary 1: exactly 50,000 SF. Score unchanged (full credit) but the label must not say "under 50,000".
test('scoreBuildingSize: exactly 50,000 SF keeps full credit and is labelled AT the ceiling, not within <50,000', () => {
  const at = engine.scoreBuildingSize(50_000);
  assert.equal(at.earned, 20);
  assert.doesNotMatch(at.note, /within target|<\s*50,000/);
  assert.match(at.note, /at the 50,000 SF/);
  assert.match(engine.scoreBuildingSize(49_999).note, /within target \(<50,000 SF\)/);
  assert.match(engine.scoreBuildingSize(50_001).note, /above target/);
  assert.equal(engine.scoreBuildingSize(50_001).earned, 20);
});

// Boundary 2: basis exactly at the floor. With early/late pct 0.5 the floor is rctLow * 0.5 (exact in
// binary), so setting rctLow = implied * 2 makes implied $/SF equal the floor bit-for-bit.
test('scoreBasis: a basis exactly at the floor is labelled as not clearing (strictly below clears)', () => {
  const sf = 10_000;
  const price = 1_000_000;
  const implied = (price * 1.02) / sf;
  const bench = { marketToRctLowPerSF: { Columbus: implied * 2 }, vintageFloor: { earlyYear: 1990, earlyPct: 0.5, lateYear: 2010, latePct: 0.5 } };
  const at = engine.scoreBasis(price, sf, 1990, 'Columbus', bench);
  assert.equal(at.earned, 0);
  assert.match(at.note, /at the replacement-cost floor/);
  assert.match(at.note, /does not clear/);
  assert.doesNotMatch(at.note, /\d/);
  assert.match(at.internalNote, /equals the RCT v03 floor/);
  assert.doesNotMatch(at.note + at.internalNote, /but not comfortably|with meaningful margin/);
  bench.marketToRctLowPerSF.Columbus = implied * 2 * (1 + 1e-9);
  assert.match(engine.scoreBasis(price, sf, 1990, 'Columbus', bench).note, /clears the replacement-cost floor but not comfortably/);
  bench.marketToRctLowPerSF.Columbus = implied * 2 * (1 - 1e-9);
  const above = engine.scoreBasis(price, sf, 1990, 'Columbus', bench);
  assert.match(above.note, /is above the replacement-cost floor/);
  assert.equal(above.earned, 0);
});

// Adversarial review follow-ups.
test('scoreDeal: undefined/null extraction does not throw and withholds the score', () => {
  for (const bad of [undefined, null, 'x', 5]) {
    const r = engine.scoreDeal(bad, rctBenchmark);
    assert.equal(r.finalScore, null);
    assertNoNaN(r);
  }
});

test('scoreDeal: a malformed benchmark floor yields needs review with no NaN text', () => {
  const bench = { marketToRctLowPerSF: { Columbus: 200 }, vintageFloor: { earlyYear: 1990, earlyPct: NaN, lateYear: 2010, latePct: 0.6 } };
  const r = engine.scoreDeal(goodDeal, bench);
  assert.equal(r.needsReview, true);
  assert.equal(r.finalScore, null);
  assert.doesNotMatch(JSON.stringify(r), /NaN/);
});

test('scoreDeal: non-string or off-list value-add signals need review and are never printed', () => {
  for (const sig of [[NaN, Infinity, 'vacancy'], [1, 2], ['foo', 'bar'], ['vacancy', 'foo'], [{}], [null]]) {
    const r = engine.scoreDeal({ ...goodDeal, valueAddSignals: sig }, rctBenchmark);
    assert.equal(r.needsReview, true, JSON.stringify(sig));
    assert.equal(r.finalScore, null);
    assert.doesNotMatch(JSON.stringify(r), /NaN|Infinity|foo/);
    assert.match(r.reviewReasons.join(' '), /Value-add signals/);
  }
});

test('scoreComplexity: duplicate signals collapse to one signal, all schema values are accepted', () => {
  assert.equal(engine.scoreComplexity(['vacancy', 'vacancy']).earned, 8);
  assert.equal(engine.scoreComplexity(['vacancy', 'legal_issue']).earned, 15);
  for (const s of ['vacancy', 'deferred_maintenance', 'environmental_issue', 'legal_issue', 'below_market_leases', 'none_stabilized']) {
    assert.notEqual(engine.scoreComplexity([s]).invalid, true, s);
  }
  const { buildExtractionTool } = require('../../../netlify/functions/_shared/broker-llm-extract.js');
  const EXTRACTION_TOOL = buildExtractionTool(rctBenchmark);
  for (const s of EXTRACTION_TOOL.input_schema.properties.valueAddSignals.items.enum) {
    assert.notEqual(engine.scoreComplexity([s]).invalid, true, `extractor enum value ${s} must be accepted`);
  }
});

test('IOS: tiny SF and a high price per SF are NOT sent to review, other classes still are', () => {
  const ios = { ...goodDeal, assetClass: 'ios', askingPrice: 5_000_000, buildingSizeSF: 2_000 }; // $2,500/SF
  assert.equal(engine.scoreDeal(ios, rctBenchmark).needsReview, false);
  assert.equal(engine.scoreDeal({ ...ios, buildingSizeSF: 400 }, rctBenchmark).needsReview, false);
  assert.equal(engine.scoreDeal({ ...ios, assetClass: 'industrial' }, rctBenchmark).needsReview, true);
  assert.equal(engine.scoreDeal({ ...ios, assetClass: 'industrial', buildingSizeSF: 400 }, rctBenchmark).needsReview, true);
  // still fail closed on non-positive / non-finite / over-max for IOS
  for (const sf of [0, -1, NaN, '2000', 6_000_000]) {
    const r = engine.scoreDeal({ ...ios, buildingSizeSF: sf }, rctBenchmark);
    assert.equal(r.needsReview, true, String(sf));
    assertNoNaN(r);
  }
  assertNoNaN(engine.scoreDeal({ ...ios, buildingSizeSF: 400 }, rctBenchmark));
});

test('IOS keeps the LOWER price-per-SF bound: land SF in the building slot is reviewed, not scored', () => {
  const ios = { ...goodDeal, assetClass: 'ios', matchedRctMarket: 'Kansas City', city: 'Kansas City', state: 'MO' };
  for (const [price, sf] of [[2_000_000, 4_900_000], [60_000, 2_000_000]]) { // $0.41/SF and $0.03/SF
    const r = engine.scoreDeal({ ...ios, askingPrice: price, buildingSizeSF: sf }, rctBenchmark);
    assert.equal(r.needsReview, true, `${price}/${sf}`);
    assert.equal(r.finalScore, null);
    assert.equal(r.categories.find((c) => c.key === 'basis').excluded, true);
  }
});

test('a sparse valueAddSignals array (holes) needs review instead of counting undefined as a signal', () => {
  const holes = ['vacancy']; holes[2] = 'vacancy';
  for (const sig of [holes, new Array(3)]) {
    const r = engine.scoreDeal({ ...goodDeal, valueAddSignals: sig }, rctBenchmark);
    assert.equal(r.needsReview, true);
    assert.doesNotMatch(JSON.stringify(r), /undefined/);
  }
});

test('a $4/SF distressed building ($180K / 45,000 SF) is scored, $0.015/SF is still reviewed', () => {
  const r = engine.scoreDeal({ ...goodDeal, askingPrice: 180_000, buildingSizeSF: 45_000 }, rctBenchmark);
  assert.equal(r.needsReview, false);
  assert.equal(typeof r.finalScore, 'number');
  assert.equal(engine.scoreDeal({ ...goodDeal, askingPrice: 60_000, buildingSizeSF: 4_000_000 }, rctBenchmark).needsReview, true);
});

test('implausible price per SF with NO matched market is flagged in the basis category payload', () => {
  const r = engine.scoreDeal({ ...goodDeal, matchedRctMarket: null, city: null, state: null, askingPrice: 5_000_000, buildingSizeSF: 600 }, rctBenchmark);
  assert.equal(r.needsReview, true);
  const basis = r.categories.find((c) => c.key === 'basis');
  assert.equal(basis.excluded, true);
  assert.match(basis.internalNote, /Implied price per SF/);
  assert.deepEqual(r.reviewReasons, ['Implied price per SF is outside the plausible range']);
});

test('a broken vintageFloor config (pct outside (0,1), non-finite, bad years) needs review, never a score', () => {
  const mk = (vf) => ({ marketToRctLowPerSF: { Columbus: 200 }, vintageFloor: vf });
  const ok = { earlyYear: 1990, earlyPct: 0.6, lateYear: 2010, latePct: 0.5 };
  assert.equal(engine.scoreDeal(goodDeal, mk(ok)).needsReview, false);
  for (const bad of [
    { ...ok, earlyPct: -5 }, { ...ok, earlyPct: 1.5 }, { ...ok, earlyPct: 0 }, { ...ok, earlyPct: 1 }, { ...ok, latePct: -0.1 },
    { ...ok, earlyPct: NaN }, { ...ok, latePct: '0.6' }, { ...ok, earlyYear: NaN }, { ...ok, earlyYear: 2010, lateYear: 2000 }, null, undefined, {},
  ]) {
    const r = engine.scoreDeal(goodDeal, mk(bad));
    assert.equal(r.needsReview, true, JSON.stringify(bad));
    assert.equal(r.finalScore, null);
    assert.doesNotMatch(JSON.stringify(r), /NaN/);
  }
});

test('scoreBuildingSize: fractional SF is displayed as scored, not rounded across the 50,000 boundary', () => {
  assert.doesNotMatch(engine.scoreBuildingSize(49_999.9999).note, /^50,000 SF/);
  assert.doesNotMatch(engine.scoreBuildingSize(50_000.0004).note, /^50,000 SF/);
});

test('email: a needs-review result renders a distinct subject and reasons, not a numeric score', () => {
  const { renderScoreFollowupEmail } = require('../../../netlify/functions/_shared/email-template.js');
  const r = engine.scoreDeal({ ...goodDeal, askingPrice: 0 }, rctBenchmark);
  const { subject, html } = renderScoreFollowupEmail({ fields: { company: 'Acme' }, score: r });
  assert.match(subject, /Needs Review/);
  assert.match(html, /Asking price is zero or negative/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

// yearBuilt is LLM-extracted and feeds the vintage floor. null/undefined means "not stated" (conservative
// default vintage); anything else must be a finite number inside the plausible window or the score is held.
test('yearBuilt bounds are exported named constants', () => {
  assert.equal(engine.PLAUSIBLE_YEAR_BUILT_MIN, 1800);
  assert.equal(engine.PLAUSIBLE_YEAR_BUILT_FUTURE_YEARS, 2);
});

test('an implausible yearBuilt needs review instead of scoring (3000 and 1e9 used to score 87 vs 75)', () => {
  const nextYear = new Date().getFullYear() + 1;
  assert.equal(engine.scoreDeal({ ...goodDeal, yearBuilt: nextYear }, rctBenchmark).needsReview, false, 'under construction / just delivered');
  const bad = [3000, 1e9, 1799, 0, -1990, NaN, Infinity, -Infinity, '1990', true, {}, [], new Date().getFullYear() + 3];
  for (const yb of bad) {
    const r = engine.scoreDeal({ ...goodDeal, yearBuilt: yb }, rctBenchmark);
    assert.equal(r.needsReview, true, `yearBuilt ${String(yb)}`);
    assert.equal(r.insufficientData, true);
    assert.equal(r.finalScore, null);
    assert.match(r.reviewReasons.join(';'), /Year built/);
    assertNoNaN(r);
  }
});

test('a bad yearBuilt is held even when price/market are missing, and a gate FAIL does not exempt it', () => {
  assert.equal(engine.scoreDeal({ ...goodDeal, yearBuilt: 3000, askingPrice: null }, rctBenchmark).needsReview, true);
  assert.equal(engine.scoreDeal({ ...goodDeal, yearBuilt: 3000, matchedRctMarket: null, city: null, state: null }, rctBenchmark).needsReview, true);
  assert.equal(engine.scoreDeal({ ...goodDeal, yearBuilt: 3000, assetClass: 'multifamily' }, rctBenchmark).needsReview, true);
});

test('valid and absent yearBuilt scores are unchanged (1800 through current year + 2, null, undefined)', () => {
  const thisYear = new Date().getFullYear();
  for (const yb of [1800, 1900, 1950, 1990, 2000, 2010, thisYear, thisYear + 2, null, undefined]) {
    const r = engine.scoreDeal({ ...goodDeal, yearBuilt: yb }, rctBenchmark);
    assert.equal(r.needsReview, false, String(yb));
    assert.equal(typeof r.finalScore, 'number', String(yb));
  }
  assert.equal(engine.scoreDeal({ ...goodDeal, yearBuilt: 1990 }, rctBenchmark).finalScore, engine.scoreDeal({ ...goodDeal, yearBuilt: null }, rctBenchmark).finalScore);
});

// IOS exempts the 500 SF floor and the standard $2,000/SF ceiling (land-like asset). A building SF entered in
// thousands (125 meaning 125,000) then used to score as a tiny building with full size credit. IOS gets its own
// much higher ceiling instead of none.
test('IOS has an implied price-per-SF ceiling: SF-in-thousands ($5M / 125 = $40,000/SF) is reviewed', () => {
  assert.equal(engine.PLAUSIBLE_IOS_PRICE_PER_SF_MAX, 25_000);
  const ios = { ...goodDeal, assetClass: 'ios', askingPrice: 5_000_000 };
  const r = engine.scoreDeal({ ...ios, buildingSizeSF: 125 }, rctBenchmark);
  assert.equal(r.needsReview, true);
  assert.equal(r.finalScore, null);
  assert.match(r.reviewReasons.join(';'), /Implied price per SF/);
  assertNoNaN(r);
  // legitimate small IOS buildings stay scored, up to the ceiling
  assert.equal(engine.scoreDeal({ ...ios, buildingSizeSF: 400 }, rctBenchmark).needsReview, false); // $12,500/SF
  assert.equal(engine.scoreDeal({ ...ios, buildingSizeSF: 2_000 }, rctBenchmark).needsReview, false);
  assert.equal(engine.scoreDeal({ ...ios, buildingSizeSF: 200 }, rctBenchmark).needsReview, false); // exactly $25,000/SF
  assert.equal(engine.scoreDeal({ ...ios, buildingSizeSF: 199 }, rctBenchmark).needsReview, true);
  // non-IOS classes keep the standard $2,000/SF ceiling
  assert.equal(engine.scoreDeal({ ...goodDeal, askingPrice: 5_000_000, buildingSizeSF: 2_000 }, rctBenchmark).needsReview, true);
});

test('IOS ceiling applies without an RCT market match too', () => {
  const r = engine.scoreDeal({ ...goodDeal, assetClass: 'ios', askingPrice: 5_000_000, buildingSizeSF: 125, matchedRctMarket: null, city: null, state: null }, rctBenchmark);
  assert.equal(r.needsReview, true);
});
