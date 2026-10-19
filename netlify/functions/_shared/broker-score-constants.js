'use strict';

// Scorecard weights and buy-box thresholds used by the public broker score engine, in one place with a
// version and a provenance link. Values here are EXACTLY what broker-score-engine.js hardcoded before this
// module existed (provenance-only change; no score moved).
//
// To change a value (new Buy Box & Scorecard ratification, or a retained site value): get Gabriel's approval, then update
// BOTH this file and tests/functions/fixtures/broker-score-retained-values.json in the same PR and bump
// SCORECARD_VERSION (move SOURCE.revision only if a new Buy Box & Scorecard revision was ratified).
// tests/functions/broker-score-constants.test.js fails on any drift between the two.

const SCORECARD_VERSION = 'site-1.1.1'; // site scorecard, independent of Buy Box & Scorecard rev 1.1 (see SOURCE)

const SOURCE = Object.freeze({
  document: 'ORA Buy Box & Scorecard (acquisition-underwriting skill)',
  revision: '1.1',
  dateRatified: '2026-06-09',
  // Skill file revision this was cross-checked against. The skill file iterates (procedure edits) without
  // moving the ratified Buy Box revision; the revision above is what matters.
  skillFileRevisionChecked: 'v4.31 (2026-10-17)',
  // PLAINLY: the site values are NOT derivable from Buy Box & Scorecard rev 1.1. Rev 1.1 is a 7-category
  // scorecard (Basis 25 / Yield 20 / Product 20 / Market 12 / Seller 10 / Tenancy 7 / Value-add) with a different
  // basis scale, size range ($500K-$10M) and height rule. The public site scorecard (5 categories,
  // 25/25/20/15/15), the 0.85 comfort factor and the tapers are a separate, site-side scheme. "Keep every
  // value as-is" was Gabriel's answer in parent session adfd24fd on 2026-10-17; this module only adds the
  // version and provenance link. Ratifying the site weights themselves is an open item.
  note: 'Site-side scorecard, independent of Buy Box & Scorecard rev 1.1 (not derivable from it); values retained as-is by Gabriel, 2026-10-17, parent session adfd24fd.',
});

function deepFreeze(o) {
  Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

const VALUES = deepFreeze({
  // Points possible per category (sum = 100).
  weights: { dealSize: 25, basis: 25, buildingSize: 20, clearHeight: 15, complexity: 15 },
  // Asking price, USD: full credit inside [targetMin, targetMax]; linear taper to 0 at zeroBelow / zeroAbove.
  dealSize: { targetMin: 1_000_000, targetMax: 10_000_000, zeroBelow: 500_000, zeroAbove: 15_000_000 },
  // Building SF: full credit below fullBelowSF; linear taper to 0 at zeroAtSF.
  buildingSize: { fullBelowSF: 50_000, zeroAtSF: 100_000 },
  // Clear height, ft: full credit at/above fullAtFt; linear taper to 0 at zeroBelowFt.
  clearHeight: { fullAtFt: 18, zeroBelowFt: 14 },
  // Basis vs replacement cost: implied $/SF = price * closingCostMultiplier / SF; credit is full at or
  // below floor * comfortableFloorFactor and tapers to 0 at the floor itself.
  basis: { closingCostMultiplier: 1.02, comfortableFloorFactor: 0.85 },
  // Value-add signals: full credit at fullAtSignals or more; singleSignalFraction of possible for one.
  complexity: { fullAtSignals: 2, singleSignalFraction: 0.5 },
  // Share of the 100 points that must have been extractable before a score is shown.
  minCoveragePct: 60,
  // Score ceiling when a property-type or market gate FAILs.
  gateFailScoreCap: 30,
  // Input-plausibility bounds for LLM-extracted figures (PR #176). NOT scoring thresholds: they never earn or
  // cost points, they only decide whether an extracted figure is believable enough to score (else the result is
  // withheld for team review). Pinned here with the scorecard values because loosening them changes which
  // deals a broker is shown a score for.
  plausibility: {
    askingPriceMin: 50_000, askingPriceMax: 500_000_000,
    buildingSfMin: 500, buildingSfMax: 5_000_000,
    iosBuildingSfMin: 1, // IOS (outside storage) assets only: just "positive"
    clearHeightMinFt: 6, clearHeightMaxFt: 100,
    pricePerSfMin: 1, pricePerSfMax: 2_000,
    iosPricePerSfMax: 25_000, // IOS only: replaces pricePerSfMax (SF-in-thousands guard)
    yearBuiltMin: 1800, yearBuiltFutureYears: 2, // valid yearBuilt is [yearBuiltMin, current year + yearBuiltFutureYears]
  },
});

module.exports = { SCORECARD_VERSION, SOURCE, VALUES };
