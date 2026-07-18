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

module.exports = { vintageFloorPct, evaluatePropertyTypeGate, evaluateMarketGate };
