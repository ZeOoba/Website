'use strict';

function vintageFloorPct(yearBuilt, cfg) {
  const yb = (yearBuilt == null || !Number.isFinite(yearBuilt)) ? cfg.earlyYear : yearBuilt;
  if (yb <= cfg.earlyYear) return cfg.earlyPct;
  if (yb >= cfg.lateYear) return cfg.latePct;
  const span = cfg.lateYear - cfg.earlyYear;
  const t = (yb - cfg.earlyYear) / span;
  return cfg.earlyPct - t * (cfg.earlyPct - cfg.latePct);
}

module.exports = { vintageFloorPct };
