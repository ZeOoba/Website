/**
 * sync-listings.mjs — reconcile a LoopNet read against data/listings.json.
 *
 * LoopNet has no API and 403s non-browser fetches, so the READ is done by the
 * weekly scheduled task through a real signed-in Chrome session. That task
 * hands this script one JSON file:
 *
 *   { "dashboard": [Property...], "public": [Property...] }
 *   Property = { loopnetId?, address, city, state, brokers?: [string],
 *                units: [{ suite, sf, sfMax?, rate (number, $/SF/yr), rateType }] }
 *
 * `dashboard` is the My Listings manager; `public` is the company page
 * (LOOPNET_COMPANY_URL). Both are required and must agree — a disagreement
 * means one read was partial, and a partial read must never delist space.
 *
 * planSync() is pure. Outcomes:
 *   noop   nothing to change
 *   apply  `next` is the new listings.json (caller regenerates + opens a PR)
 *   alert  a guard tripped; `next` is the untouched input. Fail closed.
 *
 * Run: node scripts/sync-listings.mjs <scraped.json>          (report only)
 *      node scripts/sync-listings.mjs <scraped.json> --write  (apply + regenerate)
 * Exit: 0 noop · 10 applied/would apply · 20 alert · 1 error
 */

import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';
import { RATE_TYPES, validate } from './build-listings.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'listings.json');

export const LOOPNET_COMPANY_URL = 'https://www.loopnet.com/company/oxford-realty-advisors/dkrft8kl/';

// Standing exclusions (Gabriel, 2026-09-18): listings on the company page that
// must never appear on oxfordra.net. Applied to both reads before any guard or
// diff, so an excluded listing is never added, flagged, or counted.
export const EXCLUDE = { brokers: ['scott manhoff'], cities: ['potomac'] };

// Copy in available-space.html that quotes the data; drift is warned, not rewritten.
const FAQ_SF_RANGE = [1200, 6200];
const FAQ_MARKETS = ['Columbus', 'Kansas City', 'Maryland'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const clone = (x) => JSON.parse(JSON.stringify(x));
const fmtInt = (n) => n.toLocaleString('en-US');
const sfLabel = (u) => (u.sfMax ? `${fmtInt(u.sf)}–${fmtInt(u.sfMax)} SF` : `${fmtInt(u.sf)} SF`);
const money = (n) => '$' + n.toFixed(2);

// Properties match on leading street number + state ("2012-2026 Zettler Rd" and
// "2012 Zettler Rd" both -> "2012|oh"). Uses the subtitle when the display name
// is a park name. No street number -> no key -> the read is rejected.
//
// The LoopNet listing id (the number ending the listing URL; `loopnetId` in
// listings.json) wins when both sides carry it — LoopNet's address for a park
// can differ from the site's display address.
function streetKey(address, state) {
  const m = /\d+/.exec(String(address || ''));
  return m ? `${m[0]}|${norm(state)}` : null;
}
const keyOf = (p) => (p.loopnetId ? `ln:${p.loopnetId}` : streetKey(p.address, p.state));

function indexRead(read) {
  const byKey = new Map();
  for (const p of read) {
    if (p.loopnetId) byKey.set(`ln:${p.loopnetId}`, p);
    const sk = streetKey(p.address, p.state);
    if (sk && !byKey.has(sk)) byKey.set(sk, p);
  }
  return byKey;
}
// The scraped entry for a site listing: by id first, then by street key.
function findHit(p, byKey) {
  return (p.loopnetId && byKey.get(`ln:${p.loopnetId}`)) || byKey.get(streetKey(p.subtitle || p.name, p.state)) || null;
}

export function isExcluded(p) {
  if (EXCLUDE.cities.includes(norm(p.city))) return true;
  return (p.brokers || []).some((b) => EXCLUDE.brokers.includes(norm(b)));
}

// Returns a list of problems with one read ([] = usable).
function problems(read, label) {
  const out = [];
  const seen = new Set();
  for (const p of read) {
    const who = `${label}: "${p.address}"`;
    const key = keyOf(p);
    if (!key || !p.city || !p.state) out.push(`${who} has no street number/city/state`);
    else if (seen.has(key)) out.push(`${who} matches the same property as another entry (ambiguous)`);
    seen.add(key);
    if (!Array.isArray(p.units) || p.units.length === 0) { out.push(`${who} has no units`); continue; }
    for (const u of p.units) {
      const ok = u && typeof u.suite === 'string' && u.suite !== '' &&
        Number.isFinite(u.sf) && u.sf > 0 && Number.isFinite(u.rate) && u.rate > 0 &&
        (u.sfMax === undefined || (Number.isFinite(u.sfMax) && u.sfMax > u.sf));
      if (!ok) out.push(`${who} suite "${u && u.suite}" is missing suite/sf/rate`);
      else if (!(u.rateType in RATE_TYPES)) out.push(`${who} suite "${u.suite}" has unknown rate type "${u.rateType}"`);
    }
  }
  return out;
}

// Canonical fingerprint of a read, for the dashboard-vs-public comparison.
function fingerprint(read) {
  return read.flatMap((p) => p.units.map((u) =>
    [keyOf(p), norm(u.suite), u.sf, u.sfMax || '', u.rate.toFixed(2), u.rateType].join('|'))).sort();
}

export function planSync(current, scraped) {
  const result = { action: 'noop', reasons: [], changes: [], needsInput: [], warnings: [], next: current };
  const alert = (...reasons) => ({ ...result, action: 'alert', reasons });

  const s = scraped || {};
  if (!Array.isArray(s.dashboard) || !Array.isArray(s.public)) return alert('read is missing the dashboard or public listing set');
  const dashboard = s.dashboard.filter((p) => !isExcluded(p));
  const pub = s.public.filter((p) => !isExcluded(p));
  if (dashboard.length === 0 || pub.length === 0) return alert('read returned zero listings (block page, signed-out session, or layout change)');

  const bad = [...problems(dashboard, 'dashboard'), ...problems(pub, 'public')];
  if (bad.length) return alert(...bad);

  const fd = fingerprint(dashboard);
  const fp = fingerprint(pub);
  if (fd.length !== fp.length || fd.some((x, i) => x !== fp[i])) {
    const onlyD = fd.filter((x) => !fp.includes(x));
    const onlyP = fp.filter((x) => !fd.includes(x));
    return alert(`dashboard and public pages disagree (dashboard-only: ${onlyD.join(', ') || 'none'}; public-only: ${onlyP.join(', ') || 'none'})`);
  }

  const currentUnits = current.reduce((n, p) => n + p.units.length, 0);
  const byKey = indexRead(dashboard);
  const matchedUnits = current.reduce((n, p) => {
    const hit = findHit(p, byKey);
    return n + (hit ? hit.units.length : 0);
  }, 0);
  if (currentUnits > 0 && matchedUnits < currentUnits * 0.5) {
    return alert(`more than 50% of listed units would disappear in one run (${currentUnits} -> ${matchedUnits}); treating as a bad read`);
  }

  const next = [];
  const claimed = new Set();
  for (const p of current) {
    const hit = findHit(p, byKey);
    if (!hit) { result.changes.push(`removed property: ${p.name} (no longer on LoopNet)`); continue; }
    claimed.add(hit);
    const np = clone(p);
    const old = new Map(p.units.map((u) => [norm(u.suite), u]));
    np.units = hit.units.map((u) => {
      const prev = old.get(norm(u.suite));
      const nu = { suite: prev ? prev.suite : u.suite, sf: u.sf };
      if (u.sfMax) nu.sfMax = u.sfMax;
      Object.assign(nu, { sfLabel: sfLabel(u), rate: money(u.rate), rateType: u.rateType, use: prev ? prev.use : p.category });
      if (!prev) result.changes.push(`new unit: ${p.name} Suite ${nu.suite} - ${nu.sfLabel} @ ${nu.rate} ${nu.rateType}`);
      else if (JSON.stringify(prev) !== JSON.stringify(nu)) {
        result.changes.push(`changed: ${p.name} Suite ${nu.suite} - ${prev.sfLabel} @ ${prev.rate} ${prev.rateType} -> ${nu.sfLabel} @ ${nu.rate} ${nu.rateType}`);
      }
      return prev && JSON.stringify(prev) === JSON.stringify(nu) ? clone(prev) : nu;
    });
    const kept = new Set(hit.units.map((u) => norm(u.suite)));
    for (const u of p.units) if (!kept.has(norm(u.suite))) result.changes.push(`removed unit: ${p.name} Suite ${u.suite} (no longer on LoopNet)`);
    next.push(np);
  }

  for (const p of dashboard) {
    if (claimed.has(p)) continue;
    result.needsInput.push(`new LoopNet property not on the site: ${p.address}, ${p.city}, ${p.state} (${p.units.length} unit(s)) - needs photo, lat/lng, market, category, description before it can be added to data/listings.json`);
  }

  if (result.changes.length === 0) return result;

  const sfs = next.flatMap((p) => p.units.map((u) => [u.sf, u.sfMax || u.sf])).flat();
  if (sfs.length && (Math.min(...sfs) < FAQ_SF_RANGE[0] || Math.max(...sfs) > FAQ_SF_RANGE[1])) {
    result.warnings.push(`FAQ copy in available-space.html quotes a ${fmtInt(FAQ_SF_RANGE[0])}-${fmtInt(FAQ_SF_RANGE[1])}+ SF range; listings now span ${fmtInt(Math.min(...sfs))}-${fmtInt(Math.max(...sfs))} SF - review the FAQ + FAQPage JSON-LD`);
  }
  const markets = [...new Set(next.map((p) => p.market))].sort();
  if (markets.join('|') !== [...FAQ_MARKETS].sort().join('|')) {
    result.warnings.push(`FAQ copy names markets ${FAQ_MARKETS.join(', ')}; listings now cover ${markets.join(', ') || 'none'} - review the FAQ + FAQPage JSON-LD`);
  }

  validate(next);
  return { ...result, action: 'apply', next };
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  (async () => {
    const file = process.argv[2];
    if (!file) throw new Error('usage: node scripts/sync-listings.mjs <scraped.json> [--write]');
    const current = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    const r = planSync(current, JSON.parse(await fs.readFile(file, 'utf8')));
    const { next, ...report } = r;
    console.log(JSON.stringify(report, null, 2));
    if (r.action === 'apply' && process.argv.includes('--write')) {
      await fs.writeFile(DATA_FILE, JSON.stringify(next, null, 2) + '\n');
      const gen = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-listings.mjs')], { stdio: 'inherit' });
      if (gen.status !== 0) process.exit(1);
    }
    process.exit(r.action === 'alert' ? 20 : r.action === 'apply' ? 10 : 0);
  })().catch((err) => {
    console.error('[sync-listings] FAIL:', err.message);
    process.exit(1);
  });
}
