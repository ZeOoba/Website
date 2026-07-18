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
