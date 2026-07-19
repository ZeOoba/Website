'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { vintageFloorPct } = require('../../../netlify/functions/_shared/broker-score-engine.js');
const rctBenchmark = require('../../../netlify/functions/_shared/rct-benchmark.json');

test('vintageFloorPct returns 0.65 for a building built at or before 1995', () => {
  assert.equal(vintageFloorPct(1995, rctBenchmark.vintageFloor), 0.65);
  assert.equal(vintageFloorPct(1980, rctBenchmark.vintageFloor), 0.65);
});

test('vintageFloorPct returns 0.60 for a building built in or after 2005', () => {
  assert.equal(vintageFloorPct(2005, rctBenchmark.vintageFloor), 0.60);
  assert.equal(vintageFloorPct(2024, rctBenchmark.vintageFloor), 0.60);
});

test('vintageFloorPct interpolates linearly between 1995 and 2005', () => {
  assert.equal(vintageFloorPct(2000, rctBenchmark.vintageFloor), 0.625);
});

test('vintageFloorPct defaults to the conservative 1995 floor when year built is missing', () => {
  assert.equal(vintageFloorPct(null, rctBenchmark.vintageFloor), 0.65);
  assert.equal(vintageFloorPct(undefined, rctBenchmark.vintageFloor), 0.65);
});

test('rct-benchmark.json has the four ratified RCT v03 LOW $/SF figures', () => {
  assert.equal(rctBenchmark.marketToRctLowPerSF['Maryland'], 232.97);
  assert.equal(rctBenchmark.marketToRctLowPerSF['Columbus'], 229.65);
  assert.equal(rctBenchmark.marketToRctLowPerSF['Kansas City'], 227.90);
  assert.equal(rctBenchmark.marketToRctLowPerSF['Indianapolis'], 253.83);
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

test('evaluateMarketGate PASSes when the LLM matched one of the four RCT markets', () => {
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
  const rctBenchmark = { marketToRctLowPerSF: { 'Columbus': 229.65 }, vintageFloor: { earlyYear: 1995, earlyPct: 0.65, lateYear: 2005, latePct: 0.60 } };
  // floor = 229.65 * (1 - 0.65) = 80.3775; comfortable = floor * 0.85 = 68.32
  const r = scoreBasis(2_000_000, 40_000, 1990, 'Columbus', rctBenchmark);
  assert.equal(r.possible, 25);
  assert.equal(r.earned, 25); // implied $/SF = 2,040,000/40,000 = $51 — well under $68.32
});

test('scoreBasis gives zero when priced above the RCT v03 floor', () => {
  const rctBenchmark = { marketToRctLowPerSF: { 'Columbus': 229.65 }, vintageFloor: { earlyYear: 1995, earlyPct: 0.65, lateYear: 2005, latePct: 0.60 } };
  const r = scoreBasis(4_000_000, 40_000, 1990, 'Columbus', rctBenchmark);
  assert.equal(r.earned, 0); // implied $/SF = 4,080,000/40,000 = $102 — over $80.38 floor
});

test('scoreBasis is excluded when asking price, size, or matched market is missing', () => {
  const rctBenchmark = { marketToRctLowPerSF: { 'Columbus': 229.65 }, vintageFloor: { earlyYear: 1995, earlyPct: 0.65, lateYear: 2005, latePct: 0.60 } };
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
  const rctBenchmark = require('../../../netlify/functions/_shared/rct-benchmark.json');
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
  const rctBenchmark = require('../../../netlify/functions/_shared/rct-benchmark.json');
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
  const rctBenchmark = require('../../../netlify/functions/_shared/rct-benchmark.json');
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
  const rctBenchmark = require('../../../netlify/functions/_shared/rct-benchmark.json');
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
