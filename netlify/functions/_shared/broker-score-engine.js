'use strict';

function vintageFloorPct(yearBuilt, cfg) {
  const yb = (yearBuilt == null || !Number.isFinite(yearBuilt)) ? cfg.earlyYear : yearBuilt;
  if (yb <= cfg.earlyYear) return cfg.earlyPct;
  if (yb >= cfg.lateYear) return cfg.latePct;
  const span = cfg.lateYear - cfg.earlyYear;
  const t = (yb - cfg.earlyYear) / span;
  return cfg.earlyPct - t * (cfg.earlyPct - cfg.latePct);
}

const INDUSTRIAL_ASSET_CLASSES = new Set(['industrial', 'flex', 'shallow_bay', 'ios']);
const NON_INDUSTRIAL_ASSET_CLASSES = new Set(['multifamily', 'retail', 'office', 'hospitality', 'land', 'other']);

function evaluatePropertyTypeGate(assetClass) {
  if (assetClass == null) return 'NOT_VERIFIED';
  if (INDUSTRIAL_ASSET_CLASSES.has(assetClass)) return 'PASS';
  if (NON_INDUSTRIAL_ASSET_CLASSES.has(assetClass)) return 'FAIL';
  return 'NOT_VERIFIED';
}

function evaluateMarketGate(matchedRctMarket, city, state) {
  if (matchedRctMarket) return 'PASS';
  if (city || state) return 'FAIL';
  return 'NOT_VERIFIED';
}

function fmtMoney(n) { return n.toLocaleString('en-US'); }

function scoreDealSize(askingPrice) {
  const possible = 25;
  if (askingPrice == null) return { possible, excluded: true, note: 'Asking price not stated in OM — excluded from scoring.' };
  if (askingPrice >= 1_000_000 && askingPrice <= 10_000_000) {
    return { possible, earned: possible, note: `Asking price $${fmtMoney(askingPrice)} — within target $1M-$10M.` };
  }
  if (askingPrice < 1_000_000) {
    if (askingPrice <= 500_000) return { possible, earned: 0, note: `Asking price $${fmtMoney(askingPrice)} — below target range.` };
    const t = (askingPrice - 500_000) / 500_000;
    return { possible, earned: Math.round(t * possible), note: `Asking price $${fmtMoney(askingPrice)} — below target, tapering credit.` };
  }
  if (askingPrice >= 15_000_000) return { possible, earned: 0, note: `Asking price $${fmtMoney(askingPrice)} — above target range.` };
  const t = (15_000_000 - askingPrice) / 5_000_000;
  return { possible, earned: Math.round(t * possible), note: `Asking price $${fmtMoney(askingPrice)} — above target, tapering credit.` };
}

function scoreBuildingSize(buildingSizeSF) {
  const possible = 20;
  if (buildingSizeSF == null) return { possible, excluded: true, note: 'Building size not stated in OM — excluded from scoring.' };
  if (buildingSizeSF < 50_000) return { possible, earned: possible, note: `${fmtMoney(buildingSizeSF)} SF — within target (<50,000 SF).` };
  if (buildingSizeSF >= 100_000) return { possible, earned: 0, note: `${fmtMoney(buildingSizeSF)} SF — well above target size.` };
  const t = (100_000 - buildingSizeSF) / 50_000;
  return { possible, earned: Math.round(t * possible), note: `${fmtMoney(buildingSizeSF)} SF — above target, tapering credit.` };
}

function scoreClearHeight(clearHeightFt) {
  const possible = 15;
  if (clearHeightFt == null) return { possible, excluded: true, note: 'Clear height not stated in OM — excluded from scoring.' };
  if (clearHeightFt >= 18) return { possible, earned: possible, note: `${clearHeightFt}' clear height — meets 18'+ target.` };
  if (clearHeightFt < 14) return { possible, earned: 0, note: `${clearHeightFt}' clear height — below target.` };
  const t = (clearHeightFt - 14) / 4;
  return { possible, earned: Math.round(t * possible), note: `${clearHeightFt}' clear height — below target, tapering credit.` };
}

function scoreBasis(askingPrice, buildingSizeSF, yearBuilt, matchedRctMarket, rctBenchmark) {
  const possible = 25;
  if (askingPrice == null || buildingSizeSF == null || !matchedRctMarket) {
    return { possible, excluded: true, note: 'Insufficient data to compute basis vs. replacement cost — excluded from scoring.' };
  }
  const rctLow = rctBenchmark.marketToRctLowPerSF[matchedRctMarket];
  if (rctLow == null) {
    return { possible, excluded: true, note: `No RCT v03 benchmark for "${matchedRctMarket}" — excluded from scoring.` };
  }
  const floorPct = vintageFloorPct(yearBuilt, rctBenchmark.vintageFloor);
  const floorPerSF = rctLow * (1 - floorPct);
  const impliedPricePerSF = (askingPrice * 1.02) / buildingSizeSF;
  // `note` is what the BROKER sees (broker-score-status returns it). It must never carry the floor or
  // the implied basis in dollars (2026-09-30 audit). `internalNote` keeps the figures for the
  // Gabriel/Eric email and the ledger only.
  // RESIDUAL, accepted and documented: this removes the direct print, not the inference. The broker
  // also sees `earned` for this category and the total score, and both are functions of the floor, so
  // repeated submissions can still narrow it (an independent review recovered it to about +/-0.3% from
  // a single submission landing in the 85-100% band). The per-IP rate limit and daily cap slow that; they
  // do not stop it. Closing it fully means not showing the broker the basis row or score at all.
  if (impliedPricePerSF > floorPerSF) {
    return {
      possible, earned: 0,
      note: 'Implied basis is above the replacement-cost floor for this market and vintage — does not clear ORA\'s replacement-cost discipline.',
      internalNote: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF exceeds the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF for ${matchedRctMarket} — does not clear ORA's replacement-cost discipline.`,
    };
  }
  const comfortableFloor = floorPerSF * 0.85;
  if (impliedPricePerSF <= comfortableFloor) {
    return {
      possible, earned: possible,
      note: 'Implied basis clears the replacement-cost floor with meaningful margin.',
      internalNote: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF clears the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF with meaningful margin.`,
    };
  }
  const t = (floorPerSF - impliedPricePerSF) / (floorPerSF - comfortableFloor);
  return {
    possible, earned: Math.round(t * possible),
    note: 'Implied basis clears the replacement-cost floor but not comfortably.',
    internalNote: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF clears the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF but not comfortably.`,
  };
}

function scoreComplexity(valueAddSignals) {
  const possible = 15;
  if (!valueAddSignals || valueAddSignals.length === 0) {
    return { possible, excluded: true, note: 'Value-add signals not stated in OM — excluded from scoring.' };
  }
  const realSignals = valueAddSignals.filter((s) => s !== 'none_stabilized');
  if (realSignals.length >= 2) return { possible, earned: possible, note: `Value-add signals present: ${realSignals.join(', ')}.` };
  if (realSignals.length === 1) return { possible, earned: Math.round(possible * 0.5), note: `One value-add signal present: ${realSignals[0]}.` };
  return { possible, earned: 0, note: 'Fully stabilized, turnkey asset — limited value-add angle for ORA\'s underwriting edge.' };
}

// Minimum share of the 100 scoring points that must have been extractable before a score is shown.
const MIN_COVERAGE_PCT = 60;

function scoreDeal(extracted, rctBenchmark) {
  const propertyTypeGate = evaluatePropertyTypeGate(extracted.assetClass);
  const marketGate = evaluateMarketGate(extracted.matchedRctMarket, extracted.city, extracted.state);
  const gateFailed = propertyTypeGate === 'FAIL' || marketGate === 'FAIL';

  const rawCategories = [
    { key: 'dealSize', label: 'Deal Size', ...scoreDealSize(extracted.askingPrice) },
    { key: 'basis', label: 'Acquisition Basis vs. Replacement Cost', ...scoreBasis(extracted.askingPrice, extracted.buildingSizeSF, extracted.yearBuilt, extracted.matchedRctMarket, rctBenchmark) },
    { key: 'buildingSize', label: 'Building Size', ...scoreBuildingSize(extracted.buildingSizeSF) },
    { key: 'clearHeight', label: 'Clear Height', ...scoreClearHeight(extracted.clearHeightFt) },
    { key: 'complexity', label: 'Complexity / Value-Add Fit', ...scoreComplexity(extracted.valueAddSignals) },
  ];

  const included = rawCategories.filter((c) => !c.excluded);
  const totalPossible = rawCategories.reduce((s, c) => s + c.possible, 0);
  const includedPossible = included.reduce((s, c) => s + c.possible, 0);
  const rawSum = included.reduce((s, c) => s + c.earned, 0);
  const rawWeightedScore = includedPossible > 0 ? Math.round((rawSum / includedPossible) * 100) : 0;
  const coveragePct = Math.round((includedPossible / totalPossible) * 100);
  // The score renormalizes over only the categories that extracted, so a near-empty OM could print 0 or
  // 100 with nothing to show how little was read (2026-09-30 audit). Below the coverage floor the score is
  // withheld. A VERIFIED gate failure is exempt: "outside the core box" does not depend on coverage.
  const insufficientData = !gateFailed && coveragePct < MIN_COVERAGE_PCT;
  const finalScore = insufficientData ? null : (gateFailed ? Math.min(rawWeightedScore, 30) : rawWeightedScore);

  return {
    finalScore,
    coveragePct,
    insufficientData,
    gates: { propertyType: propertyTypeGate, market: marketGate },
    gateFailed,
    categories: rawCategories.map((c) => ({
      key: c.key, label: c.label, possible: c.possible, excluded: !!c.excluded,
      earned: c.excluded ? null : c.earned, note: c.note, internalNote: c.internalNote || c.note,
    })),
  };
}

module.exports = {
  vintageFloorPct, evaluatePropertyTypeGate, evaluateMarketGate,
  scoreDealSize, scoreBuildingSize, scoreClearHeight, scoreBasis, scoreComplexity,
  scoreDeal,
};
