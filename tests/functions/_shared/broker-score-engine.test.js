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
