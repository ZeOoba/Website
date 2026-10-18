'use strict';

const { SCORECARD_VERSION, VALUES: SC } = require('./broker-score-constants');

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

// Up to 6 fraction digits so a fractional figure is shown as scored (49,999.9999 must not print as "50,000").
function fmtMoney(n) { return n.toLocaleString('en-US', { maximumFractionDigits: 6 }); }

// Plausibility bounds for LLM-extracted inputs. These are NOT scoring thresholds and never feed a
// score: they only decide whether an extracted figure is believable enough to score at all. A value
// outside them (or non-numeric, zero, negative, non-finite) fails closed to a "needs review" outcome
// instead of earning credit. Wide enough that a real buy-box deal is not rejected (a $4/SF distressed
// building at $180K / 45,000 SF passes by design), tight enough to catch zero, $-in-thousands and
// SF-in-thousands for buy-box-size deals, and runaway figures.
// IOS (outdoor storage) is land-like: its "building" SF can be tiny or absent relative to price, so for
// assetClass 'ios' the UPPER price-per-SF bound and the 500 SF minimum are NOT applied (finite/positive,
// SF >= 1, the $1/SF lower bound and the price and SF maximums still are). Other classes get the full bounds.
// ACCEPTED RESIDUAL: a wrong FIELD or unit that still lands inside these bounds (for example NOI in the
// price slot, SF in square metres, a large price quoted in $000s) is not detectable here and is scored.
const PLAUSIBLE_ASKING_PRICE_MIN = SC.plausibility.askingPriceMin;
const PLAUSIBLE_ASKING_PRICE_MAX = SC.plausibility.askingPriceMax;
const PLAUSIBLE_BUILDING_SF_MIN = SC.plausibility.buildingSfMin;
const PLAUSIBLE_BUILDING_SF_MAX = SC.plausibility.buildingSfMax;
const PLAUSIBLE_CLEAR_HEIGHT_MIN_FT = SC.plausibility.clearHeightMinFt;
const PLAUSIBLE_CLEAR_HEIGHT_MAX_FT = SC.plausibility.clearHeightMaxFt;
const PLAUSIBLE_IOS_BUILDING_SF_MIN = SC.plausibility.iosBuildingSfMin;
const PLAUSIBLE_PRICE_PER_SF_MIN = SC.plausibility.pricePerSfMin;
const PLAUSIBLE_PRICE_PER_SF_MAX = SC.plausibility.pricePerSfMax;

// Returns null when `v` is usable (a finite number inside [min, max]), else a short reason. Strings are
// rejected, not coerced: "5000000" or "$5M" from the model means the extraction did not follow the schema.
function invalidNumberReason(v, min, max) {
  if (typeof v !== 'number') return 'is not a number';
  if (!Number.isFinite(v)) return 'is not finite';
  if (v <= 0) return 'is zero or negative';
  if (v < min || v > max) return 'is outside the plausible range';
  return null;
}

// `note` is broker-visible, so it carries no figures; `reviewReason` is internal (email/ledger).
function invalidCategory(possible, label, reason) {
  return { possible, excluded: true, invalid: true, reviewReason: `${label} ${reason}`, note: `${label} could not be validated — held for team review.` };
}

function scoreDealSize(askingPrice) {
  const possible = SC.weights.dealSize;
  if (askingPrice == null) return { possible, excluded: true, note: 'Asking price not stated in OM — excluded from scoring.' };
  const bad = invalidNumberReason(askingPrice, PLAUSIBLE_ASKING_PRICE_MIN, PLAUSIBLE_ASKING_PRICE_MAX);
  if (bad) return invalidCategory(possible, 'Asking price', bad);
  if (askingPrice >= SC.dealSize.targetMin && askingPrice <= SC.dealSize.targetMax) {
    return { possible, earned: possible, note: `Asking price $${fmtMoney(askingPrice)} — within target $1M-$10M.` };
  }
  if (askingPrice < SC.dealSize.targetMin) {
    if (askingPrice <= SC.dealSize.zeroBelow) return { possible, earned: 0, note: `Asking price $${fmtMoney(askingPrice)} — below target range.` };
    const t = (askingPrice - SC.dealSize.zeroBelow) / (SC.dealSize.targetMin - SC.dealSize.zeroBelow);
    return { possible, earned: Math.round(t * possible), note: `Asking price $${fmtMoney(askingPrice)} — below target, tapering credit.` };
  }
  if (askingPrice >= SC.dealSize.zeroAbove) return { possible, earned: 0, note: `Asking price $${fmtMoney(askingPrice)} — above target range.` };
  const t = (SC.dealSize.zeroAbove - askingPrice) / (SC.dealSize.zeroAbove - SC.dealSize.targetMax);
  return { possible, earned: Math.round(t * possible), note: `Asking price $${fmtMoney(askingPrice)} — above target, tapering credit.` };
}

function scoreBuildingSize(buildingSizeSF, opts = {}) {
  const possible = SC.weights.buildingSize;
  if (buildingSizeSF == null) return { possible, excluded: true, note: 'Building size not stated in OM — excluded from scoring.' };
  const bad = invalidNumberReason(buildingSizeSF, opts.ios ? PLAUSIBLE_IOS_BUILDING_SF_MIN : PLAUSIBLE_BUILDING_SF_MIN, PLAUSIBLE_BUILDING_SF_MAX);
  if (bad) return invalidCategory(possible, 'Building size', bad);
  if (buildingSizeSF < SC.buildingSize.fullBelowSF) return { possible, earned: possible, note: `${fmtMoney(buildingSizeSF)} SF — within target (<50,000 SF).` };
  // Exactly 50,000 SF is not under the ceiling (the buy-box is strictly sub-50K) but the taper below earns
  // full credit at that point, so the score is unchanged; only the label is made to match the comparison.
  if (buildingSizeSF === SC.buildingSize.fullBelowSF) return { possible, earned: possible, note: `${fmtMoney(buildingSizeSF)} SF — at the 50,000 SF target ceiling (not under it); full credit.` };
  if (buildingSizeSF >= SC.buildingSize.zeroAtSF) return { possible, earned: 0, note: `${fmtMoney(buildingSizeSF)} SF — well above target size.` };
  const t = (SC.buildingSize.zeroAtSF - buildingSizeSF) / (SC.buildingSize.zeroAtSF - SC.buildingSize.fullBelowSF);
  return { possible, earned: Math.round(t * possible), note: `${fmtMoney(buildingSizeSF)} SF — above target, tapering credit.` };
}

function scoreClearHeight(clearHeightFt) {
  const possible = SC.weights.clearHeight;
  if (clearHeightFt == null) return { possible, excluded: true, note: 'Clear height not stated in OM — excluded from scoring.' };
  const bad = invalidNumberReason(clearHeightFt, PLAUSIBLE_CLEAR_HEIGHT_MIN_FT, PLAUSIBLE_CLEAR_HEIGHT_MAX_FT);
  if (bad) return invalidCategory(possible, 'Clear height', bad);
  if (clearHeightFt >= SC.clearHeight.fullAtFt) return { possible, earned: possible, note: `${clearHeightFt}' clear height — meets 18'+ target.` };
  if (clearHeightFt < SC.clearHeight.zeroBelowFt) return { possible, earned: 0, note: `${clearHeightFt}' clear height — below target.` };
  // Exactly 14' earns 0 (the taper starts at 0 here); label it as the floor, not as tapering credit.
  if (clearHeightFt === SC.clearHeight.zeroBelowFt) return { possible, earned: 0, note: `${clearHeightFt}' clear height — at the 14' floor, below target; no credit.` };
  const t = (clearHeightFt - SC.clearHeight.zeroBelowFt) / (SC.clearHeight.fullAtFt - SC.clearHeight.zeroBelowFt);
  return { possible, earned: Math.round(t * possible), note: `${clearHeightFt}' clear height — below target, tapering credit.` };
}

// A vintageFloor config whose years or percentages are not finite, or whose percentages fall outside
// (0, 1), is a broken benchmark: a negative pct would make the floor exceed replacement cost.
function vintageFloorConfigValid(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const { earlyYear, lateYear, earlyPct, latePct } = cfg;
  return [earlyYear, lateYear].every((y) => typeof y === 'number' && Number.isFinite(y))
    && earlyYear < lateYear
    && [earlyPct, latePct].every((p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1);
}

function scoreBasis(askingPrice, buildingSizeSF, yearBuilt, matchedRctMarket, rctBenchmark, opts = {}) {
  const possible = SC.weights.basis;
  if (askingPrice == null || buildingSizeSF == null) {
    return { possible, excluded: true, note: 'Insufficient data to compute basis vs. replacement cost — excluded from scoring.' };
  }
  const badPrice = invalidNumberReason(askingPrice, PLAUSIBLE_ASKING_PRICE_MIN, PLAUSIBLE_ASKING_PRICE_MAX);
  if (badPrice) return invalidCategory(possible, 'Asking price', badPrice);
  const badSF = invalidNumberReason(buildingSizeSF, opts.ios ? PLAUSIBLE_IOS_BUILDING_SF_MIN : PLAUSIBLE_BUILDING_SF_MIN, PLAUSIBLE_BUILDING_SF_MAX);
  if (badSF) return invalidCategory(possible, 'Building size', badSF);
  // Checked before the market match so an implausible price/SF pair is flagged (and shows up in the
  // category payload) even when no RCT market matched. IOS is land-like and exempt from the band.
  const rawPerSF = askingPrice / buildingSizeSF;
  // IOS drops only the UPPER bound (small SF relative to price). The lower bound still applies: land SF
  // dropped into the building slot would otherwise earn full basis credit against building replacement cost.
  if (!(rawPerSF >= PLAUSIBLE_PRICE_PER_SF_MIN && (opts.ios || rawPerSF <= PLAUSIBLE_PRICE_PER_SF_MAX))) {
    return invalidCategory(possible, 'Implied price per SF', 'is outside the plausible range');
  }
  if (!matchedRctMarket) {
    return { possible, excluded: true, note: 'Insufficient data to compute basis vs. replacement cost — excluded from scoring.' };
  }
  const rctLow = rctBenchmark.marketToRctLowPerSF[matchedRctMarket];
  if (typeof rctLow !== 'number' || !Number.isFinite(rctLow) || rctLow <= 0) {
    // A market that IS in the benchmark but carries a bad value (string, NaN, negative, zero) is a broken
    // benchmark, not a missing one: hold for review instead of silently renormalising around it.
    if (Object.prototype.hasOwnProperty.call(rctBenchmark.marketToRctLowPerSF, matchedRctMarket)) {
      return invalidCategory(possible, 'Replacement-cost benchmark', 'is not a positive number');
    }
    return { possible, excluded: true, note: `No RCT v03 benchmark for "${matchedRctMarket}" — excluded from scoring.` };
  }
  // Markets whose benchmark is a proxy for another market's figure (RCT v3.1 `proxy: true`). Shown in the
  // INTERNAL note only, so Gabriel and Eric know the floor behind a score is not directly sourced.
  const proxySuffix = (rctBenchmark.proxyMarkets || []).includes(matchedRctMarket)
    ? ` [proxy benchmark for ${matchedRctMarket}, not a directly sourced figure]` : '';
  if (!vintageFloorConfigValid(rctBenchmark.vintageFloor)) {
    return invalidCategory(possible, 'Replacement-cost floor', 'could not be computed');
  }
  const floorPct = vintageFloorPct(yearBuilt, rctBenchmark.vintageFloor);
  const floorPerSF = rctLow * (1 - floorPct);
  if (!Number.isFinite(floorPct) || !Number.isFinite(floorPerSF) || floorPerSF <= 0) return invalidCategory(possible, 'Replacement-cost floor', 'could not be computed');
  const impliedPricePerSF = (askingPrice * SC.basis.closingCostMultiplier) / buildingSizeSF;
  // `note` is what the BROKER sees (broker-score-status returns it). It must never carry the floor or
  // the implied basis in dollars (2026-09-30 audit). `internalNote` keeps the figures for the
  // Gabriel/Eric email and the ledger only.
  // RESIDUAL, accepted and documented: this removes the direct print, not the inference. The broker
  // also sees `earned` for this category and the total score, and both are functions of the floor, so
  // repeated submissions can still narrow it (an independent review recovered it to about +/-0.3% from
  // a single submission landing in the 85-100% band). The per-IP rate limit and daily cap slow that; they
  // do not stop it. Closing it fully means not showing the broker the basis row or score at all.
  // Clearing the floor means being strictly BELOW it. A basis exactly at the floor earns 0 either way
  // (the taper below starts at 0 there), so it is grouped with "does not clear" and labelled as such.
  if (impliedPricePerSF >= floorPerSF) {
    const atFloor = impliedPricePerSF === floorPerSF;
    return {
      possible, earned: 0,
      note: atFloor
        ? 'Implied basis is at the replacement-cost floor for this market and vintage, not below it — does not clear ORA\'s replacement-cost discipline.'
        : 'Implied basis is above the replacement-cost floor for this market and vintage — does not clear ORA\'s replacement-cost discipline.',
      internalNote: atFloor
        ? `Implied basis $${impliedPricePerSF.toFixed(2)}/SF equals the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF for ${matchedRctMarket} (not below it) — does not clear ORA's replacement-cost discipline.${proxySuffix}`
        : `Implied basis $${impliedPricePerSF.toFixed(2)}/SF exceeds the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF for ${matchedRctMarket} — does not clear ORA's replacement-cost discipline.${proxySuffix}`,
    };
  }
  const comfortableFloor = floorPerSF * SC.basis.comfortableFloorFactor;
  if (impliedPricePerSF <= comfortableFloor) {
    return {
      possible, earned: possible,
      note: 'Implied basis clears the replacement-cost floor with meaningful margin.',
      internalNote: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF clears the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF with meaningful margin.${proxySuffix}`,
    };
  }
  const t = (floorPerSF - impliedPricePerSF) / (floorPerSF - comfortableFloor);
  return {
    possible, earned: Math.round(t * possible),
    note: 'Implied basis clears the replacement-cost floor but not comfortably.',
    internalNote: `Implied basis $${impliedPricePerSF.toFixed(2)}/SF clears the RCT v03 floor of $${floorPerSF.toFixed(2)}/SF but not comfortably.${proxySuffix}`,
  };
}

// Mirrors the enum in broker-llm-extract.js EXTRACTION_TOOL (valueAddSignals.items.enum).
const VALUE_ADD_SIGNALS = new Set(['vacancy', 'deferred_maintenance', 'environmental_issue', 'legal_issue', 'below_market_leases', 'none_stabilized']);

function scoreComplexity(valueAddSignals) {
  const possible = SC.weights.complexity;
  if (!Array.isArray(valueAddSignals) || valueAddSignals.length === 0) {
    return { possible, excluded: true, note: 'Value-add signals not stated in OM — excluded from scoring.' };
  }
  // Only the extractor schema's own values count. A non-string or off-list entry is a schema violation:
  // hold for review rather than dropping it (which could empty the list and renormalise around it) or
  // crediting it as a real signal. Duplicates collapse, so ['vacancy','vacancy'] is one signal, not two.
  // Array.from visits holes as undefined (Array.prototype.every skips them), so a sparse array is rejected.
  const signals = Array.from(valueAddSignals);
  if (!signals.every((s) => typeof s === 'string' && VALUE_ADD_SIGNALS.has(s))) {
    return invalidCategory(possible, 'Value-add signals', 'contain a value outside the allowed list');
  }
  const realSignals = [...new Set(signals)].filter((s) => s !== 'none_stabilized');
  if (realSignals.length >= SC.complexity.fullAtSignals) return { possible, earned: possible, note: `Value-add signals present: ${realSignals.join(', ')}.` };
  if (realSignals.length > 0) return { possible, earned: Math.round(possible * SC.complexity.singleSignalFraction), note: `One value-add signal present: ${realSignals[0]}.` };
  return { possible, earned: 0, note: 'Fully stabilized, turnkey asset — limited value-add angle for ORA\'s underwriting edge.' };
}

// Minimum share of the 100 scoring points that must have been extractable before a score is shown.
const MIN_COVERAGE_PCT = SC.minCoveragePct;

function scoreDeal(extractedIn, rctBenchmark) {
  const extracted = (extractedIn && typeof extractedIn === 'object') ? { ...extractedIn } : {};
  const sizeOpts = { ios: extracted.assetClass === 'ios' };
  const propertyTypeGate = evaluatePropertyTypeGate(extracted.assetClass);
  // The extractor's schema constrains matchedRctMarket to the benchmark keys, but the engine must not rely on
  // the model obeying it: any other string ("Phoenix") used to PASS the market gate uncapped. Treat a market
  // that is not an own key of the benchmark as unmatched (independent review 2026-10-01, F2).
  const matchedRctMarket = Object.prototype.hasOwnProperty.call(rctBenchmark.marketToRctLowPerSF || {}, extracted.matchedRctMarket)
    ? extracted.matchedRctMarket : null;
  const marketGate = evaluateMarketGate(matchedRctMarket, extracted.city, extracted.state);
  const gateFailed = propertyTypeGate === 'FAIL' || marketGate === 'FAIL';

  const rawCategories = [
    { key: 'dealSize', label: 'Deal Size', ...scoreDealSize(extracted.askingPrice) },
    { key: 'basis', label: 'Acquisition Basis vs. Replacement Cost', ...scoreBasis(extracted.askingPrice, extracted.buildingSizeSF, extracted.yearBuilt, matchedRctMarket, rctBenchmark, sizeOpts) },
    { key: 'buildingSize', label: 'Building Size', ...scoreBuildingSize(extracted.buildingSizeSF, sizeOpts) },
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
  // withheld. A gate FAIL is exempt: "outside the core box" does not depend on coverage. Note what a FAIL
  // means here: a non-industrial asset class, or an extracted city/state that is not one of the markets in
  // the RCT benchmark. It does NOT mean the OM was fully read, so a thin OM where only a city outside those
  // markets was extracted still shows the broker a capped score at low coverage. Kept deliberately
  // (owner decision 2026-10-01, independent review F1): a city outside the benchmark markets is outside the box.
  // Fail closed on bad extracted figures: a category whose input was present but invalid (zero, negative,
  // non-finite, string, wrong-unit, implausible) must not be silently dropped and renormalised around, since
  // that would let the remaining categories print a clean-looking score. Any such category, or any
  // non-finite number anywhere in the arithmetic, withholds the score for human review. Even a gate FAIL
  // does not exempt it: the cap of 30 is only trustworthy if the figures behind it were readable.
  // An invalid price or SF fails both its own category and basis with the same text: de-duplicate.
  const reviewReasons = [...new Set(rawCategories.filter((c) => c.invalid).map((c) => c.reviewReason))];
  // The implied $/SF plausibility check runs inside scoreBasis BEFORE the market match, so it also flags
  // (and puts a reason in the basis category) when no RCT market matched.
  const arithmeticBroken = included.some((c) => !Number.isFinite(c.earned)) || !Number.isFinite(rawWeightedScore) || !Number.isFinite(coveragePct);
  if (arithmeticBroken) reviewReasons.push('Scoring arithmetic produced a non-finite value');
  const needsReview = reviewReasons.length > 0;

  // needsReview also sets insufficientData so every existing consumer (broker status endpoint, ledger
  // score-total) already treats the result as "no score" without a schema change.
  const insufficientData = needsReview || (!gateFailed && coveragePct < MIN_COVERAGE_PCT);
  const finalScore = insufficientData ? null : (gateFailed ? Math.min(rawWeightedScore, SC.gateFailScoreCap) : rawWeightedScore);

  return {
    scorecardVersion: SCORECARD_VERSION,
    finalScore,
    coveragePct: Number.isFinite(coveragePct) ? coveragePct : 0,
    insufficientData,
    needsReview,
    reviewReasons,
    gates: { propertyType: propertyTypeGate, market: marketGate },
    gateFailed,
    categories: rawCategories.map((c) => ({
      key: c.key, label: c.label, possible: c.possible, excluded: !!c.excluded,
      earned: c.excluded ? null : (Number.isFinite(c.earned) ? c.earned : null),
      note: c.note, internalNote: c.internalNote || c.reviewReason || c.note,
    })),
  };
}

module.exports = {
  PLAUSIBLE_ASKING_PRICE_MIN, PLAUSIBLE_ASKING_PRICE_MAX, PLAUSIBLE_BUILDING_SF_MIN, PLAUSIBLE_BUILDING_SF_MAX,
  PLAUSIBLE_IOS_BUILDING_SF_MIN, PLAUSIBLE_CLEAR_HEIGHT_MIN_FT, PLAUSIBLE_CLEAR_HEIGHT_MAX_FT, PLAUSIBLE_PRICE_PER_SF_MIN, PLAUSIBLE_PRICE_PER_SF_MAX,
  vintageFloorPct, evaluatePropertyTypeGate, evaluateMarketGate,
  scoreDealSize, scoreBuildingSize, scoreClearHeight, scoreBasis, scoreComplexity,
  scoreDeal,
};
