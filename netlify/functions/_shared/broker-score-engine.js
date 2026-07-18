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
  if (impliedPricePerSF > floorPerSF) {
    return { possible, earned: 0, note: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF exceeds the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF for ${matchedRctMarket} — does not clear ORA's replacement-cost discipline.` };
  }
  const comfortableFloor = floorPerSF * 0.85;
  if (impliedPricePerSF <= comfortableFloor) {
    return { possible, earned: possible, note: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF clears the RCT v03 floor with meaningful margin.` };
  }
  const t = (floorPerSF - impliedPricePerSF) / (floorPerSF - comfortableFloor);
  return { possible, earned: Math.round(t * possible), note: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF clears the RCT v03 floor but not comfortably.` };
}

module.exports = { vintageFloorPct, evaluatePropertyTypeGate, evaluateMarketGate, scoreDealSize, scoreBuildingSize, scoreClearHeight, scoreBasis };
