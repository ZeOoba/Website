'use strict';
// sync-listings.mjs planSync — pure diff + fail-closed guards between a LoopNet
// read (dashboard, cross-checked against the public pages) and data/listings.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const load = () => import(url.pathToFileURL(path.join(ROOT, 'scripts', 'sync-listings.mjs')).href);
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listings.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// A scrape that mirrors the current data exactly.
function mirror() {
  return DATA.map((p) => ({
    address: p.subtitle || p.name, city: p.city, state: p.state,
    units: p.units.map((u) => {
      const o = { suite: u.suite, sf: u.sf, rate: parseFloat(u.rate.slice(1)), rateType: u.rateType };
      if (u.sfMax) o.sfMax = u.sfMax;
      return o;
    }),
  }));
}

test('identical read -> noop, data untouched', async () => {
  const { planSync } = await load();
  const r = planSync(DATA, { dashboard: mirror(), public: mirror() });
  assert.strictEqual(r.action, 'noop');
  assert.deepStrictEqual(r.next, DATA);
});

test('rate change, leased unit, new unit -> apply with summary', async () => {
  const { planSync } = await load();
  const s = mirror();
  s[0].units[0].rate = 12.5;                       // Zettler 2016 repriced
  s[2].units.pop();                                // Zettler 2002 leased
  s[5].units.push({ suite: '112', sf: 1000, rate: 11, rateType: '+UTIL' });
  const r = planSync(DATA, { dashboard: s, public: clone(s) });
  assert.strictEqual(r.action, 'apply');
  assert.strictEqual(r.next[0].units[0].rate, '$12.50');
  assert.strictEqual(r.next[2].units.length, 1);
  assert.deepStrictEqual(r.next[5].units[2], { suite: '112', sf: 1000, sfLabel: '1,000 SF', rate: '$11.00', rateType: '+UTIL', use: 'Retail' });
  assert.strictEqual(r.changes.length, 3);
  assert.strictEqual(DATA[0].units[0].rate, '$11.67', 'input must not be mutated');
});

test('property gone from LoopNet -> removed', async () => {
  const { planSync } = await load();
  const s = mirror().slice(1);
  const r = planSync(DATA, { dashboard: s, public: s });
  assert.strictEqual(r.action, 'apply');
  assert.strictEqual(r.next.length, DATA.length - 1);
  assert.ok(r.changes.some((c) => /removed.*2012-2026 Zettler Rd/.test(c)));
});

test('new property is flagged, never auto-added (needs photo + lat/lng)', async () => {
  const { planSync } = await load();
  const s = mirror();
  s.push({ address: '55 New Plant Ct', city: 'Owings Mills', state: 'MD', units: [{ suite: 'A', sf: 3000, rate: 12, rateType: 'NNN' }] });
  const r = planSync(DATA, { dashboard: s, public: s });
  assert.strictEqual(r.action, 'noop');
  assert.strictEqual(r.next.length, DATA.length);
  assert.strictEqual(r.needsInput.length, 1);
  assert.match(r.needsInput[0], /55 New Plant Ct/);
});

test('fail closed: empty / missing dashboard or public read', async () => {
  const { planSync } = await load();
  for (const scraped of [{ dashboard: [], public: [] }, { public: mirror() }, { dashboard: mirror() }, {}]) {
    const r = planSync(DATA, scraped);
    assert.strictEqual(r.action, 'alert');
    assert.deepStrictEqual(r.next, DATA);
  }
});

test('fail closed: more than half the units vanish in one run', async () => {
  const { planSync } = await load();
  const s = mirror().slice(0, 2); // 2 of 8 units left
  const r = planSync(DATA, { dashboard: s, public: s });
  assert.strictEqual(r.action, 'alert');
  assert.match(r.reasons.join(' '), /50%/);
  assert.deepStrictEqual(r.next, DATA);
});

test('fail closed: dashboard and public pages disagree', async () => {
  const { planSync } = await load();
  const d = mirror(); const p = mirror();
  d[0].units[0].rate = 12.5;
  const r = planSync(DATA, { dashboard: d, public: p });
  assert.strictEqual(r.action, 'alert');
  assert.match(r.reasons.join(' '), /disagree/);
});

test('fail closed: malformed unit (no sf, unknown rate type, ambiguous match)', async () => {
  const { planSync } = await load();
  const a = mirror(); delete a[0].units[0].sf;
  assert.strictEqual(planSync(DATA, { dashboard: a, public: a }).action, 'alert');
  const b = mirror(); b[0].units[0].rateType = 'FSG';
  assert.strictEqual(planSync(DATA, { dashboard: b, public: b }).action, 'alert');
  const c = mirror(); c.push(clone(c[0]));
  assert.strictEqual(planSync(DATA, { dashboard: c, public: c }).action, 'alert');
});

test('FAQ copy drift is warned, not rewritten', async () => {
  const { planSync } = await load();
  const s = mirror();
  s[5].units.push({ suite: '200', sf: 9000, rate: 9, rateType: '+UTIL' });
  const r = planSync(DATA, { dashboard: s, public: s });
  assert.strictEqual(r.action, 'apply');
  assert.ok(r.warnings.some((w) => /FAQ/.test(w)));
});

test('standing exclusions: Scott Manhoff listings and anything in Potomac never reach the site', async () => {
  const { planSync } = await load();
  const s = mirror();
  s.push({ address: '100 Broker Way', city: 'Rockville', state: 'MD', brokers: ['Gabriel Goldberg', ' scott  MANHOFF '], units: [{ suite: '1', sf: 2000, rate: 20, rateType: 'NNN' }] });
  s.push({ address: '200 River Rd', city: 'Potomac', state: 'MD', units: [{ suite: '1', sf: 2000, rate: 30, rateType: 'NNN' }] });
  const r = planSync(DATA, { dashboard: s, public: mirror() }); // excluded rows do not count as a disagreement either
  assert.strictEqual(r.action, 'noop');
  assert.deepStrictEqual(r.needsInput, []);
  assert.deepStrictEqual(r.next, DATA);
});

test('loopnetId wins over address: a LoopNet address that differs from the site still matches', async () => {
  const { planSync } = await load();
  const cur = clone(DATA);
  cur[3].loopnetId = '33776831';
  const s = mirror();
  Object.assign(s[3], { loopnetId: '33776831', address: '2205 Northwood Dr', city: 'Salisbury' });
  s[3].units[0].sfMax = 3600;
  const r = planSync(cur, { dashboard: s, public: clone(s) });
  assert.strictEqual(r.action, 'apply');
  assert.deepStrictEqual(r.needsInput, []);
  assert.strictEqual(r.next[3].units[0].sfMax, 3600);
  assert.strictEqual(r.next[3].city, 'Easton', 'site-owned fields are never overwritten by the read');
});
