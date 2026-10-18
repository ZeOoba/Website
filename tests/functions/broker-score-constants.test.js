'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCORECARD_VERSION, SOURCE, VALUES } = require('../../netlify/functions/_shared/broker-score-constants.js');
const engine = require('../../netlify/functions/_shared/broker-score-engine.js');
const rctBenchmark = require('../../netlify/functions/_shared/rct-benchmark.json');
const retained = require('./fixtures/broker-score-retained-values.json');

const HOW_TO = ' To change a scorecard value on purpose: get Gabriel\'s approval, then update BOTH '
  + 'netlify/functions/_shared/broker-score-constants.js and tests/functions/fixtures/broker-score-retained-values.json '
  + 'in the same PR (bump SCORECARD_VERSION, e.g. site-1.1.1; move SOURCE.revision ONLY when Gabriel ratifies a new Buy Box & Scorecard revision). '
  + 'If this failure is unintended, revert the value.';

test('scorecard values match the retained-values fixture exactly', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(VALUES)), retained.values,
    'Scorecard weights/thresholds drifted from the retained-values fixture (revision ' + retained.source.revision + ').' + HOW_TO);
});

test('version and provenance match the fixture revision', () => {
  assert.equal(SCORECARD_VERSION, retained.scorecardVersion, 'SCORECARD_VERSION drifted.' + HOW_TO);
  assert.equal(SOURCE.revision, retained.source.revision, 'SOURCE.revision drifted.' + HOW_TO);
  assert.equal(SOURCE.document, retained.source.document);
  assert.equal(SOURCE.dateRatified, retained.source.dateRatified);
  assert.equal(SOURCE.skillFileRevisionChecked, retained.source.skillFileRevisionChecked);
});

test('category weights total 100', () => {
  assert.equal(Object.values(retained.values.weights).reduce((a, b) => a + b, 0), 100);
});

test('rct-benchmark vintage floor ramp matches the retained-values fixture', () => {
  assert.deepEqual(rctBenchmark.vintageFloor, retained.vintageFloor,
    'netlify/functions/_shared/rct-benchmark.json vintageFloor drifted from the retained-values fixture (tests/functions/fixtures/broker-score-retained-values.json). Revert it, or update both files together with Gabriel approval.');
});

test('constants are frozen (no runtime mutation)', () => {
  assert.ok(Object.isFrozen(VALUES) && Object.isFrozen(VALUES.weights) && Object.isFrozen(SOURCE));
});

test('engine behaviour follows the fixture values at every threshold', () => {
  const v = retained.values;
  const pts = (r) => r.earned;
  assert.equal(pts(engine.scoreDealSize(v.dealSize.targetMin)), v.weights.dealSize);
  assert.equal(pts(engine.scoreDealSize(v.dealSize.targetMax)), v.weights.dealSize);
  assert.equal(pts(engine.scoreDealSize(v.dealSize.zeroBelow)), 0);
  assert.equal(pts(engine.scoreDealSize(v.dealSize.zeroAbove)), 0);
  assert.equal(pts(engine.scoreBuildingSize(v.buildingSize.fullBelowSF - 1)), v.weights.buildingSize);
  assert.equal(pts(engine.scoreBuildingSize(v.buildingSize.zeroAtSF)), 0);
  assert.equal(pts(engine.scoreClearHeight(v.clearHeight.fullAtFt)), v.weights.clearHeight);
  assert.equal(pts(engine.scoreClearHeight(v.clearHeight.zeroBelowFt - 0.1)), 0);
  assert.equal(pts(engine.scoreComplexity(['a', 'b'])), v.weights.complexity);
  assert.equal(pts(engine.scoreComplexity(['a'])), Math.round(v.weights.complexity * v.complexity.singleSignalFraction));
  assert.equal(engine.scoreBasis(1, 1, 2000, 'Columbus', rctBenchmark).possible, v.weights.basis);
});

test('scoreDeal output carries the scorecard version', () => {
  const r = engine.scoreDeal({ askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: 20, valueAddSignals: ['a'], assetClass: 'industrial', matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000 }, rctBenchmark);
  assert.equal(r.scorecardVersion, retained.scorecardVersion);
});

// Engine-side threshold tests: expected values are derived from the FIXTURE, never from the constants
// module, so an engine that stops reading the module (or a tuned module value) cannot stay green.
test('basis taper midpoint, closing-cost multiplier and comfort factor are pinned by the fixture', () => {
  const v = retained.values;
  const low = rctBenchmark.marketToRctLowPerSF.Columbus;
  const vf = retained.vintageFloor;
  const floorPct = vf.earlyPct - ((2000 - vf.earlyYear) / (vf.lateYear - vf.earlyYear)) * (vf.earlyPct - vf.latePct);
  const floor = low * (1 - floorPct);
  const comfortable = floor * v.basis.comfortableFloorFactor;
  const sf = 10_000;
  const priceFor = (implied) => (implied * sf) / v.basis.closingCostMultiplier;
  const mid = engine.scoreBasis(priceFor((floor + comfortable) / 2), sf, 2000, 'Columbus', rctBenchmark);
  assert.equal(mid.earned, Math.round(v.weights.basis * 0.5));
  assert.equal(engine.scoreBasis(priceFor(comfortable * 0.99), sf, 2000, 'Columbus', rctBenchmark).earned, v.weights.basis);
  assert.equal(engine.scoreBasis(priceFor(floor * 1.01), sf, 2000, 'Columbus', rctBenchmark).earned, 0);
});

test('deal-size taper midpoints are pinned by the fixture', () => {
  const d = retained.values.dealSize;
  const w = retained.values.weights.dealSize;
  assert.equal(engine.scoreDealSize((d.targetMax + d.zeroAbove) / 2).earned, Math.round(w * 0.5));
  assert.equal(engine.scoreDealSize((d.zeroBelow + d.targetMin) / 2).earned, Math.round(w * 0.5));
});

test('broker-visible notes quote the fixture thresholds', () => {
  const v = retained.values;
  const fmt = (n) => n.toLocaleString('en-US');
  assert.ok(engine.scoreDealSize(v.dealSize.targetMin).note.includes(`$${v.dealSize.targetMin / 1e6}M-$${v.dealSize.targetMax / 1e6}M`),
    'Deal-size note text no longer matches the retained thresholds; update the note in broker-score-engine.js.');
  assert.ok(engine.scoreBuildingSize(1000).note.includes(`<${fmt(v.buildingSize.fullBelowSF)} SF`),
    'Building-size note text no longer matches the retained threshold.');
  assert.ok(engine.scoreClearHeight(v.clearHeight.fullAtFt).note.includes(`${v.clearHeight.fullAtFt}'+`),
    'Clear-height note text no longer matches the retained threshold.');
});

// Dense sweeps against a reference formula written from the FIXTURE only. Rounding hides small constant
// shifts at a single probe, so many points are compared.
test('dense sweeps: every taper matches the fixture-derived reference', () => {
  const v = retained.values;
  const lin = (num, den, w) => Math.round((num / den) * w);
  const prices = [];
  for (let p = 400_000; p <= 16_000_000; p += 7_919) prices.push(p);
  for (let p = v.dealSize.zeroBelow; p <= v.dealSize.targetMin; p += 101) prices.push(p);
  for (let p = v.dealSize.targetMax; p <= v.dealSize.zeroAbove; p += 1_009) prices.push(p);
  for (const p of prices) {
    let e;
    if (p >= v.dealSize.targetMin && p <= v.dealSize.targetMax) e = v.weights.dealSize;
    else if (p < v.dealSize.targetMin) e = p <= v.dealSize.zeroBelow ? 0 : lin(p - v.dealSize.zeroBelow, v.dealSize.targetMin - v.dealSize.zeroBelow, v.weights.dealSize);
    else e = p >= v.dealSize.zeroAbove ? 0 : lin(v.dealSize.zeroAbove - p, v.dealSize.zeroAbove - v.dealSize.targetMax, v.weights.dealSize);
    assert.equal(engine.scoreDealSize(p).earned, e, `deal size @ ${p}`);
  }
  for (let sf = 10_000; sf <= 110_000; sf += 137) {
    const e = sf < v.buildingSize.fullBelowSF ? v.weights.buildingSize
      : sf >= v.buildingSize.zeroAtSF ? 0
        : lin(v.buildingSize.zeroAtSF - sf, v.buildingSize.zeroAtSF - v.buildingSize.fullBelowSF, v.weights.buildingSize);
    assert.equal(engine.scoreBuildingSize(sf).earned, e, `building @ ${sf}`);
  }
  for (let h = 10; h <= 22; h += 0.0137) {
    const e = h >= v.clearHeight.fullAtFt ? v.weights.clearHeight : h < v.clearHeight.zeroBelowFt ? 0
      : lin(h - v.clearHeight.zeroBelowFt, v.clearHeight.fullAtFt - v.clearHeight.zeroBelowFt, v.weights.clearHeight);
    assert.equal(engine.scoreClearHeight(h).earned, e, `clear height @ ${h}`);
  }
  const low = rctBenchmark.marketToRctLowPerSF.Columbus;
  const vf = retained.vintageFloor;
  const floor = low * (1 - (vf.earlyPct - ((2000 - vf.earlyYear) / (vf.lateYear - vf.earlyYear)) * (vf.earlyPct - vf.latePct)));
  const comfortable = floor * v.basis.comfortableFloorFactor;
  const sf = 10_000;
  for (let k = 0.7; k <= 1.1; k += 0.00037) {
    const implied = floor * k;
    const price = (implied * sf) / v.basis.closingCostMultiplier;
    const r = engine.scoreBasis(price, sf, 2000, 'Columbus', rctBenchmark);
    const realImplied = (price * v.basis.closingCostMultiplier) / sf;
    const e = realImplied > floor ? 0 : realImplied <= comfortable ? v.weights.basis
      : lin(floor - realImplied, floor - comfortable, v.weights.basis);
    assert.equal(r.earned, e, `basis @ ${k}`);
    assert.ok(r.internalNote.includes(`$${realImplied.toFixed(2)}/SF`), 'internalNote implied basis must reflect the fixture closing-cost multiplier');
    assert.ok(r.internalNote.includes(`$${floor.toFixed(2)}/SF`), 'internalNote floor must reflect the fixture vintage floor');
  }
});

test('gate FAIL caps the score at the fixture cap', () => {
  const r = engine.scoreDeal({ askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: 20, valueAddSignals: ['a', 'b'], assetClass: 'retail', matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000 }, rctBenchmark);
  assert.equal(r.gateFailed, true);
  assert.equal(r.finalScore, retained.values.gateFailScoreCap);
});

test('boundary notes are stable at exact thresholds', () => {
  const d = retained.values.dealSize;
  assert.match(engine.scoreDealSize(d.targetMax + 1).note, /above target, tapering credit/);
  assert.match(engine.scoreDealSize(d.targetMax).note, /within target/);
  assert.match(engine.scoreBuildingSize(retained.values.buildingSize.fullBelowSF).note, /above target, tapering credit/);
  assert.match(engine.scoreBuildingSize(retained.values.buildingSize.fullBelowSF - 1).note, /within target/);
});

test('boundary notes at the zero-credit thresholds are stable', () => {
  const v = retained.values;
  assert.match(engine.scoreDealSize(v.dealSize.zeroBelow).note, /below target range/);
  assert.match(engine.scoreDealSize(v.dealSize.zeroBelow + 1).note, /below target, tapering credit/);
  assert.match(engine.scoreDealSize(v.dealSize.zeroAbove).note, /above target range/);
  assert.match(engine.scoreDealSize(v.dealSize.zeroAbove - 1).note, /above target, tapering credit/);
  assert.match(engine.scoreBuildingSize(v.buildingSize.zeroAtSF).note, /well above target size/);
  assert.match(engine.scoreBuildingSize(v.buildingSize.zeroAtSF - 1).note, /above target, tapering credit/);
  assert.match(engine.scoreClearHeight(v.clearHeight.zeroBelowFt).note, /below target, tapering credit/);
  assert.match(engine.scoreClearHeight(v.clearHeight.zeroBelowFt - 0.01).note, /below target\.$/);
});

// Rounding flips happen at half-point inputs that sweeps rarely land on. Probe each flip point and its
// neighbours directly, with expectations derived from the fixture only.
test('taper half-point flip points match the fixture-derived reference', () => {
  const v = retained.values;
  const probe = (w, zero, full, score, near, step) => {
    for (let k = 0; k < w; k++) {
      const x = zero + (full - zero) * ((k + 0.5) / w);
      for (let d = -3; d <= 3; d++) {
        const input = Math.round(x / step) * step + d * step;
        const lo = Math.min(zero, full); const hi = Math.max(zero, full);
        if (input <= lo || input >= hi) continue;
        const e = Math.round((Math.abs(input - zero) / Math.abs(full - zero)) * w);
        assert.equal(score(input), e, `flip probe ${input}`);
      }
    }
    assert.ok(near);
  };
  probe(v.weights.dealSize, v.dealSize.zeroBelow, v.dealSize.targetMin, (p) => engine.scoreDealSize(p).earned, true, 1);
  probe(v.weights.dealSize, v.dealSize.zeroAbove, v.dealSize.targetMax, (p) => engine.scoreDealSize(p).earned, true, 1);
  probe(v.weights.buildingSize, v.buildingSize.zeroAtSF, v.buildingSize.fullBelowSF, (s) => engine.scoreBuildingSize(s).earned, true, 1);
  for (let sf = v.buildingSize.fullBelowSF; sf <= v.buildingSize.zeroAtSF; sf++) {
    const e = sf === v.buildingSize.fullBelowSF ? Math.round(((v.buildingSize.zeroAtSF - sf) / (v.buildingSize.zeroAtSF - v.buildingSize.fullBelowSF)) * v.weights.buildingSize) : Math.round(((v.buildingSize.zeroAtSF - sf) / (v.buildingSize.zeroAtSF - v.buildingSize.fullBelowSF)) * v.weights.buildingSize);
    assert.equal(engine.scoreBuildingSize(sf).earned, sf >= v.buildingSize.zeroAtSF ? 0 : e, `building @ ${sf}`);
  }
  probe(v.weights.clearHeight, v.clearHeight.zeroBelowFt, v.clearHeight.fullAtFt, (h) => engine.scoreClearHeight(h).earned, true, 0.001);
});

test('basis note tier follows the fixture at the exact floor and comfort edges', () => {
  const v = retained.values;
  const vf = retained.vintageFloor;
  const low = rctBenchmark.marketToRctLowPerSF.Columbus;
  const floor = low * (1 - (vf.earlyPct - ((2000 - vf.earlyYear) / (vf.lateYear - vf.earlyYear)) * (vf.earlyPct - vf.latePct)));
  const comfortable = floor * v.basis.comfortableFloorFactor;
  const sf = 10_000;
  const at = (implied) => engine.scoreBasis((implied * sf) / v.basis.closingCostMultiplier, sf, 2000, 'Columbus', rctBenchmark);
  const eps = 1e-7;
  assert.match(at(floor * (1 + eps)).note, /does not clear/);
  assert.match(at(floor * (1 - eps)).note, /but not comfortably/);
  assert.match(at(comfortable * (1 + eps)).note, /but not comfortably/);
  assert.match(at(comfortable * (1 - eps)).note, /meaningful margin/);
});

test('exact floating-point equality at the floor and comfort edges keeps its tier', () => {
  // Integer inputs whose implied basis lands exactly on the floor / comfort floor (found by exhaustive
  // search against the pre-extraction engine). Equality must stay on the lenient side of each comparison.
  assert.match(engine.scoreBasis(2772343, 34680, null, 'Maryland', rctBenchmark).note, /but not comfortably/);
  assert.match(engine.scoreBasis(2912125, 40000, 2000, 'Maryland', rctBenchmark).note, /meaningful margin/);
});

test('basis taper and final-score rounding match the fixture-derived reference at integer resolution', () => {
  const v = retained.values;
  const vf = retained.vintageFloor;
  const sf = 10_000;
  for (const [market, year] of [['Columbus', 2000], ['Maryland', null]]) {
    const low = rctBenchmark.marketToRctLowPerSF[market];
    const yb = year == null ? vf.earlyYear : year;
    const pct = yb <= vf.earlyYear ? vf.earlyPct : yb >= vf.lateYear ? vf.latePct
      : vf.earlyPct - ((yb - vf.earlyYear) / (vf.lateYear - vf.earlyYear)) * (vf.earlyPct - vf.latePct);
    const floor = low * (1 - pct);
    const comfortable = floor * v.basis.comfortableFloorFactor;
    const lo = Math.floor((comfortable * sf) / v.basis.closingCostMultiplier) - 50;
    const hi = Math.ceil((floor * sf) / v.basis.closingCostMultiplier) + 50;
    for (let price = lo; price <= hi; price += 1) {
      const implied = (price * v.basis.closingCostMultiplier) / sf;
      const e = implied > floor ? 0 : implied <= comfortable ? v.weights.basis
        : Math.round(((floor - implied) / (floor - comfortable)) * v.weights.basis);
      assert.equal(engine.scoreBasis(price, sf, year, market, rctBenchmark).earned, e, `${market} basis @ ${price}`);
    }
  }
  // Fractional SF is allowed by the extractor schema.
  for (let s = v.buildingSize.fullBelowSF; s <= v.buildingSize.zeroAtSF; s += 0.25) {
    const e = s >= v.buildingSize.zeroAtSF ? 0 : Math.round(((v.buildingSize.zeroAtSF - s) / (v.buildingSize.zeroAtSF - v.buildingSize.fullBelowSF)) * v.weights.buildingSize);
    assert.equal(engine.scoreBuildingSize(s).earned, e, `building @ ${s}`);
  }
  // finalScore rounding: deal size + basis + building size extracted (70% coverage), clear height and complexity not.
  const include = v.weights.dealSize + v.weights.basis + v.weights.buildingSize;
  for (let price = 600_000; price <= 990_000; price += 7_001) {
    for (const bsf of [55_000, 61_234, 77_777, 93_001]) {
      const r = engine.scoreDeal({ askingPrice: price, buildingSizeSF: bsf, clearHeightFt: null, valueAddSignals: null, assetClass: 'industrial', matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000 }, rctBenchmark);
      const sum = r.categories.reduce((a, c) => a + (c.excluded ? 0 : c.earned), 0);
      assert.equal(r.finalScore, Math.round((sum / include) * 100), `finalScore @ ${price}/${bsf}`);
    }
  }
});

test('clear-height taper matches the fixture reference at literal feet, tenths, hundredths and feet+inches', () => {
  const v = retained.values;
  const ref = (h) => (h >= v.clearHeight.fullAtFt ? v.weights.clearHeight : h < v.clearHeight.zeroBelowFt ? 0
    : Math.round(((h - v.clearHeight.zeroBelowFt) / (v.clearHeight.fullAtFt - v.clearHeight.zeroBelowFt)) * v.weights.clearHeight));
  const heights = [];
  for (let n = 1300; n <= 1900; n++) heights.push(n / 100);
  for (let n = 130; n <= 190; n++) heights.push(n / 10);
  for (let f = 13; f <= 19; f++) for (let i = 0; i < 12; i++) heights.push(f + i / 12);
  for (const h of heights) assert.equal(engine.scoreClearHeight(h).earned, ref(h), `clear height @ ${h}`);
});
