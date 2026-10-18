'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCORECARD_VERSION, SOURCE, VALUES } = require('../../netlify/functions/_shared/broker-score-constants.js');
const engine = require('../../netlify/functions/_shared/broker-score-engine.js');
const rctBenchmark = require('../../netlify/functions/_shared/rct-benchmark.json');
const retained = require('./fixtures/broker-score-retained-values.json');
const crypto = require('node:crypto');

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
  assert.equal(pts(engine.scoreComplexity(['vacancy', 'legal_issue'])), v.weights.complexity);
  assert.equal(pts(engine.scoreComplexity(['vacancy'])), Math.round(v.weights.complexity * v.complexity.singleSignalFraction));
  assert.equal(engine.scoreBasis(2_000_000, 40_000, 2000, 'Columbus', rctBenchmark).possible, v.weights.basis);
});

test('scoreDeal output carries the scorecard version', () => {
  const r = engine.scoreDeal({ askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: 20, valueAddSignals: ['vacancy'], assetClass: 'industrial', matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000 }, rctBenchmark);
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
  const r = engine.scoreDeal({ askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: 20, valueAddSignals: ['vacancy', 'legal_issue'], assetClass: 'retail', matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000 }, rctBenchmark);
  assert.equal(r.gateFailed, true);
  assert.equal(r.finalScore, retained.values.gateFailScoreCap);
});

test('boundary notes are stable at exact thresholds', () => {
  const d = retained.values.dealSize;
  assert.match(engine.scoreDealSize(d.targetMax + 1).note, /above target, tapering credit/);
  assert.match(engine.scoreDealSize(d.targetMax).note, /within target/);
  assert.match(engine.scoreBuildingSize(retained.values.buildingSize.fullBelowSF).note, new RegExp(`at the ${retained.values.buildingSize.fullBelowSF.toLocaleString('en-US')} SF target ceiling`));
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
  assert.match(engine.scoreClearHeight(v.clearHeight.zeroBelowFt).note, new RegExp(`at the ${retained.values.clearHeight.zeroBelowFt}' floor`));
  assert.match(engine.scoreClearHeight(v.clearHeight.zeroBelowFt + 0.5).note, /below target, tapering credit/);
  assert.match(engine.scoreClearHeight(v.clearHeight.zeroBelowFt - 0.01).note, /below target\.$/);
});

// Rounding flips happen at half-point inputs that sweeps rarely land on. Probe each flip point and its
// neighbours directly, with expectations derived from the fixture only.
test('taper half-point flip points match the fixture-derived reference', () => {
  const v = retained.values;
  const probe = (w, zero, full, score, step) => {
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
  };
  probe(v.weights.dealSize, v.dealSize.zeroBelow, v.dealSize.targetMin, (p) => engine.scoreDealSize(p).earned, 1);
  probe(v.weights.dealSize, v.dealSize.zeroAbove, v.dealSize.targetMax, (p) => engine.scoreDealSize(p).earned, 1);
  probe(v.weights.buildingSize, v.buildingSize.zeroAtSF, v.buildingSize.fullBelowSF, (s) => engine.scoreBuildingSize(s).earned, 1);
  for (let sf = v.buildingSize.fullBelowSF; sf <= v.buildingSize.zeroAtSF; sf++) {
    const e = sf >= v.buildingSize.zeroAtSF ? 0
      : Math.round(((v.buildingSize.zeroAtSF - sf) / (v.buildingSize.zeroAtSF - v.buildingSize.fullBelowSF)) * v.weights.buildingSize);
    assert.equal(engine.scoreBuildingSize(sf).earned, e, `building @ ${sf}`);
  }
  probe(v.weights.clearHeight, v.clearHeight.zeroBelowFt, v.clearHeight.fullAtFt, (h) => engine.scoreClearHeight(h).earned, 0.001);
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
  // search against the pre-extraction engine). Equality at the floor is labelled as such (earned 0, PR #176); equality at the comfort floor earns full credit.
  assert.match(engine.scoreBasis(2772343, 34680, null, 'Maryland', rctBenchmark).note, /at the replacement-cost floor/);
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

test('coverage minimum withholds the score exactly at the fixture boundary', () => {
  const v = retained.values;
  const base = { assetClass: 'industrial', matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000, valueAddSignals: null };
  // dealSize + basis + buildingSize extracted = 70% coverage (>= min): shown. Drop buildingSize and basis: 25%.
  const w = v.weights;
  const shown = engine.scoreDeal({ ...base, askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: null }, rctBenchmark);
  assert.equal(shown.coveragePct, w.dealSize + w.basis + w.buildingSize);
  assert.equal(shown.insufficientData, shown.coveragePct < v.minCoveragePct);
  // Just below the minimum: dealSize + clearHeight + complexity = 55%.
  const exact = engine.scoreDeal({ ...base, askingPrice: 2_000_000, buildingSizeSF: null, clearHeightFt: 20, valueAddSignals: ['vacancy'] }, rctBenchmark);
  assert.equal(exact.coveragePct, w.dealSize + w.clearHeight + w.complexity);
  assert.equal(exact.insufficientData, exact.coveragePct < v.minCoveragePct);
  const below = engine.scoreDeal({ ...base, askingPrice: 2_000_000, buildingSizeSF: null, clearHeightFt: 20, valueAddSignals: null }, rctBenchmark);
  assert.equal(below.insufficientData, below.coveragePct < v.minCoveragePct);
  assert.equal(below.insufficientData, true);
});

test('plausibility bounds are exported from the fixture values', () => {
  const p = retained.values.plausibility;
  assert.equal(engine.PLAUSIBLE_ASKING_PRICE_MIN, p.askingPriceMin);
  assert.equal(engine.PLAUSIBLE_ASKING_PRICE_MAX, p.askingPriceMax);
  assert.equal(engine.PLAUSIBLE_BUILDING_SF_MIN, p.buildingSfMin);
  assert.equal(engine.PLAUSIBLE_BUILDING_SF_MAX, p.buildingSfMax);
  assert.equal(engine.PLAUSIBLE_CLEAR_HEIGHT_MIN_FT, p.clearHeightMinFt);
  assert.equal(engine.PLAUSIBLE_CLEAR_HEIGHT_MAX_FT, p.clearHeightMaxFt);
  assert.equal(engine.PLAUSIBLE_PRICE_PER_SF_MIN, p.pricePerSfMin);
  assert.equal(engine.PLAUSIBLE_PRICE_PER_SF_MAX, p.pricePerSfMax);
  // Behaviour at each bound edge: inside scores, just outside is held for review.
  assert.equal(engine.scoreDealSize(p.askingPriceMin).invalid, undefined);
  assert.equal(engine.scoreDealSize(p.askingPriceMin - 1).invalid, true);
  assert.equal(engine.scoreDealSize(p.askingPriceMax).invalid, undefined);
  assert.equal(engine.scoreDealSize(p.askingPriceMax + 1).invalid, true);
  assert.equal(engine.scoreBuildingSize(p.buildingSfMin).invalid, undefined);
  assert.equal(engine.scoreBuildingSize(p.buildingSfMin - 1).invalid, true);
  assert.equal(engine.scoreBuildingSize(p.buildingSfMax).invalid, undefined);
  assert.equal(engine.scoreBuildingSize(p.buildingSfMax + 1).invalid, true);
  assert.equal(engine.scoreClearHeight(p.clearHeightMinFt).invalid, undefined);
  assert.equal(engine.scoreClearHeight(p.clearHeightMinFt - 0.1).invalid, true);
  assert.equal(engine.scoreClearHeight(p.clearHeightMaxFt).invalid, undefined);
  assert.equal(engine.scoreClearHeight(p.clearHeightMaxFt + 0.1).invalid, true);
  const rct = rctBenchmark;
  const sf = 10_000;
  const bigSf = 1_000_000; // keeps price >= askingPriceMin at the per-SF minimum
  assert.equal(engine.scoreBasis(p.pricePerSfMin * bigSf, bigSf, 2000, 'Columbus', rct).invalid, undefined);
  assert.equal(engine.scoreBasis(p.pricePerSfMin * bigSf - 1, bigSf, 2000, 'Columbus', rct).invalid, true);
  // IOS assets: only 'positive' building SF is required.
  assert.equal(engine.scoreBuildingSize(p.iosBuildingSfMin, { ios: true }).invalid, undefined);
  assert.equal(engine.scoreBuildingSize(p.iosBuildingSfMin - 0.5, { ios: true }).invalid, true);
  assert.equal(engine.scoreBuildingSize(p.iosBuildingSfMin, {}).invalid, true);
  assert.equal(engine.PLAUSIBLE_IOS_BUILDING_SF_MIN, p.iosBuildingSfMin);
  assert.equal(engine.scoreBasis(p.pricePerSfMax * sf, sf, 2000, 'Columbus', rct).invalid, undefined);
  assert.equal(engine.scoreBasis(p.pricePerSfMax * sf + 1, sf, 2000, 'Columbus', rct).invalid, true);
});

test('coverage is withheld at 55 and shown at exactly the 60 minimum (literal expectations)', () => {
  const w = retained.values.weights;
  assert.equal(retained.values.minCoveragePct, 60);
  assert.equal(w.dealSize + w.buildingSize + w.clearHeight, 60);
  const none = { assetClass: 'industrial', matchedRctMarket: null, city: null, state: null, yearBuilt: 2000 };
  const at60 = engine.scoreDeal({ ...none, askingPrice: 2_000_000, buildingSizeSF: 40_000, clearHeightFt: 20, valueAddSignals: null }, rctBenchmark);
  assert.equal(at60.coveragePct, 60);
  assert.equal(at60.insufficientData, false);
  assert.notEqual(at60.finalScore, null);
  const at55 = engine.scoreDeal({ ...none, askingPrice: 2_000_000, buildingSizeSF: null, clearHeightFt: 20, valueAddSignals: ['vacancy'] }, rctBenchmark);
  assert.equal(at55.coveragePct, 55);
  assert.equal(at55.insufficientData, true);
  assert.equal(at55.finalScore, null);
});

test('implied price-per-SF plausibility edges apply without a market match', () => {
  const p = retained.values.plausibility;
  const none = { assetClass: 'industrial', matchedRctMarket: null, city: null, state: null, yearBuilt: 2000, clearHeightFt: 20, valueAddSignals: ['vacancy', 'legal_issue'] };
  const run = (price, sf) => engine.scoreDeal({ ...none, askingPrice: price, buildingSizeSF: sf }, rctBenchmark);
  const sf = 1_000_000;
  assert.equal(run(p.pricePerSfMin * sf, sf).needsReview, false);
  assert.equal(run(p.pricePerSfMin * sf - 1, sf).needsReview, true);
  assert.equal(run(p.pricePerSfMax * 1_000, 1_000).needsReview, false);
  assert.equal(run(p.pricePerSfMax * 1_000 + 1, 1_000).needsReview, true);
});

test('scoreBasis and scoreDeal apply the same size/height bounds at the point of use (incl. IOS)', () => {
  const p = retained.values.plausibility;
  const rct = rctBenchmark;
  const basis = (price, sf, opts) => engine.scoreBasis(price, sf, 2000, 'Columbus', rct, opts);
  // IOS: only positive SF; the per-SF floor still applies.
  assert.equal(basis(2_000_000, p.iosBuildingSfMin, { ios: true }).invalid, undefined);
  assert.equal(basis(2_000_000, p.iosBuildingSfMin - 0.5, { ios: true }).invalid, true);
  assert.equal(basis(p.pricePerSfMin * 1_000_000, 1_000_000, { ios: true }).invalid, undefined);
  assert.equal(basis(p.pricePerSfMin * 1_000_000 - 1, 1_000_000, { ios: true }).invalid, true);
  assert.equal(basis(p.pricePerSfMax * 1_000, 1_000, { ios: true }).invalid, undefined);
  // IOS is exempt from the per-SF ceiling (land-heavy), but not from the floor above; non-IOS is not exempt.
  assert.equal(basis(p.pricePerSfMax * 1_000 + 1, 1_000, { ios: true }).invalid, undefined);
  assert.equal(basis(p.pricePerSfMax * 1_000 + 1, 1_000, {}).invalid, true);
  // Non-IOS: buildingSfMin applies.
  assert.equal(basis(900_000, p.buildingSfMin, {}).invalid, undefined);
  assert.equal(basis(900_000, p.buildingSfMin - 1, {}).invalid, true);
  assert.equal(basis(p.askingPriceMin, 50_000, {}).invalid, undefined);
  assert.equal(basis(p.askingPriceMin - 1, 50_000, {}).invalid, true);
  assert.equal(basis(p.askingPriceMax, 5_000_000, {}).invalid, undefined);
  assert.equal(basis(p.askingPriceMax + 1, 5_000_000, {}).invalid, true);
  // scoreDeal level: IOS passes at the IOS minimum SF, industrial does not; clear-height max edge fails closed.
  const deal = (assetClass, sf, h, price = 2_000_000) => engine.scoreDeal({ assetClass, matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000, askingPrice: price, buildingSizeSF: sf, clearHeightFt: h, valueAddSignals: ['vacancy', 'legal_issue'] }, rct);
  assert.equal(deal('ios', p.iosBuildingSfMin, 20).needsReview, false);
  assert.equal(deal('industrial', p.iosBuildingSfMin, 20).needsReview, true);
  assert.equal(deal('industrial', p.buildingSfMin, 20, 900_000).needsReview, false);
  assert.equal(deal('industrial', p.buildingSfMin - 1, 20, 900_000).needsReview, true);
  assert.equal(deal('industrial', 40_000, p.clearHeightMaxFt).needsReview, false);
  assert.equal(deal('industrial', 40_000, p.clearHeightMaxFt + 1e-6).needsReview, true);
  assert.equal(deal('industrial', 40_000, p.clearHeightMinFt).needsReview, false);
  assert.equal(deal('industrial', 40_000, p.clearHeightMinFt - 1e-6).needsReview, true);
});

test('only the ios asset class gets the IOS size exemption; basis edges at the point of use', () => {
  const p = retained.values.plausibility;
  const rct = rctBenchmark;
  const deal = (assetClass, sf, price) => engine.scoreDeal({ assetClass, matchedRctMarket: 'Columbus', city: 'Columbus', state: 'OH', yearBuilt: 2000, askingPrice: price, buildingSizeSF: sf, clearHeightFt: 20, valueAddSignals: ['vacancy', 'legal_issue'] }, rct);
  for (const cls of ['flex', 'shallow_bay', 'industrial', 'IOS']) {
    assert.equal(deal(cls, p.buildingSfMin - 1, 900_000).needsReview, true, `${cls} below the SF minimum`);
    assert.equal(deal(cls, 400, 2_000_000).needsReview, true, `${cls} 400 SF`);
  }
  assert.equal(deal('ios', 400, 2_000_000).needsReview, false);
  const basis = (price, sf) => engine.scoreBasis(price, sf, 2000, 'Columbus', rct, {});
  assert.equal(basis(10_000_000, p.buildingSfMax).invalid, undefined);
  assert.equal(basis(10_000_000, p.buildingSfMax + 1).invalid, true);
  assert.equal(basis(p.askingPriceMin - 1, 40_000).invalid, true);
});

const canon = (o) => (o && typeof o === 'object' ? '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}' : JSON.stringify(o));
const hashValues = (o) => crypto.createHash('sha256').update(canon(o)).digest('hex');

test('changing any scorecard value forces a SCORECARD_VERSION bump', () => {
  // versionHistory maps each released version to the hash of its VALUES. Editing a value without adding a new
  // version leaves the current version's hash stale and fails here. Overwriting an old entry to silence this is
  // visible in review (the fixture diff shows a released version's hash changing).
  const entry = retained.versionHistory[SCORECARD_VERSION];
  assert.ok(entry, 'SCORECARD_VERSION ' + SCORECARD_VERSION + ' has no versionHistory entry in the fixture.' + HOW_TO);
  assert.equal(hashValues(VALUES), entry,
    'Scorecard VALUES changed but SCORECARD_VERSION did not. Bump SCORECARD_VERSION (e.g. site-1.1.1) and add its hash to versionHistory in the fixture; never edit an existing history entry.' + HOW_TO);
  assert.equal(hashValues(retained.values), entry, 'Fixture values do not match their own versionHistory hash.');
});

test('deal-size labels and credit just below the target minimum', () => {
  const d = retained.values.dealSize;
  for (const price of [d.targetMin - 10_000, d.targetMin - 1]) {
    assert.match(engine.scoreDealSize(price).note, /below target, tapering credit/, `label @ ${price}`);
  }
  assert.ok(engine.scoreDealSize(d.targetMin - 1).earned <= retained.values.weights.dealSize);
  assert.match(engine.scoreDealSize(d.targetMin).note, /within target/);
  const e = (p) => Math.round(((p - d.zeroBelow) / (d.targetMin - d.zeroBelow)) * retained.values.weights.dealSize);
  for (const price of [990_000, 995_000, 999_000, 999_999]) {
    assert.equal(engine.scoreDealSize(price).earned, e(price), `credit @ ${price}`);
  }
});
