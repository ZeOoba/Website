'use strict';
// build-portfolio.mjs: the pure rules behind the portfolio page. data/portfolio.json
// is the live source here (it changes only by deliberate edit, unlike listings.json),
// and the rules under test are the publishing rules the page must never break.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const load = () => import(url.pathToFileURL(path.join(ROOT, 'scripts', 'build-portfolio.mjs')).href);
const ASSETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'portfolio.json'), 'utf8'));
const asset = (name) => ASSETS.find((a) => a.name === name);

test('mix shares are whole percents that sum to exactly 100', async () => {
  const { mixShares } = await load();
  const shares = mixShares(ASSETS);
  assert.strictEqual(shares.flex + shares.ios + shares.other, 100);
  assert.ok(shares.flex > shares.ios && shares.flex > shares.other, 'shallow-bay industrial/flex is the core');
  // largest-remainder rounding on a hand-checkable case
  const toy = [
    { name: 'a', sf: 1, type: 'Industrial/Flex' },
    { name: 'b', sf: 1, type: 'Industrial + IOS' },
    { name: 'c', sf: 1, type: 'Office/Retail' },
  ];
  const t = mixShares(toy);
  assert.strictEqual(t.flex + t.ios + t.other, 100);
  assert.deepStrictEqual(Object.values(t).sort(), [33, 33, 34]);
});

test('chips come only from sourced specs, never hand-typed, and cap at three', async () => {
  const { chipsFor } = await load();
  assert.deepStrictEqual(chipsFor(asset('55 New Plant Court')), ['Single-tenant', 'Truck docks', "20' ceilings"]);
  assert.deepStrictEqual(chipsFor(asset('2012-2026 Zettler Rd')), ['Multi-tenant', 'Drive-in doors']);
  assert.deepStrictEqual(chipsFor(asset('2203-2207 Northwood Dr')), [], 'an asset with no sourced specs gets no chips');
  for (const a of ASSETS) assert.ok(chipsFor(a).length <= 3, a.name);
});

test('every asset has building-level coordinates inside its state', async () => {
  const { validateAssets } = await load();
  assert.doesNotThrow(() => validateAssets(ASSETS));
  const bad = (patch) => () => validateAssets([{ ...asset('9050 Red Branch Road'), ...patch }]);
  assert.throws(bad({ lat: 39.23, lng: -76.82 }), /4 decimals/, '2-decimal pins are ~1 km off');
  assert.throws(bad({ lat: 39.22908, lng: 76.81735 }), /outside MD/, 'a dropped minus sign');
  assert.throws(bad({ lat: 'x', lng: -76.81735 }), /required/);
  assert.throws(bad({ state: 'ZZ' }), /no coordinate bounds/);
});

test('acquisition months: ISO format, rendered Mon YYYY, and held rows stay undated', async () => {
  const { fmtAcquired, validateAssets } = await load();
  assert.strictEqual(fmtAcquired('2015-08'), 'Aug 2015');
  assert.strictEqual(fmtAcquired('2026-01'), 'Jan 2026');
  for (const a of ASSETS) if (a.acquired) assert.match(a.acquired, /^\d{4}-(0[1-9]|1[0-2])$/, a.name);
  assert.throws(() => validateAssets([{ ...asset('9050 Red Branch Road'), acquired: '2015' }]), /ISO month/);
  // Source: settlement-statement register (WebsiteTransactions_Data_v01, 2026-10-02).
  assert.strictEqual(asset('1900 North Broadway').acquired, '2015-08', 'Broadway closed 2015-08-31 (a 2017 date from Case Studies.docx was wrong)');
  assert.strictEqual(asset('9050 Red Branch Road').acquired, '2015-08');
  // The register marks these publish_default "hold_until_verified": OCR-damaged statements and an open
  // related-party question. Do not date them publicly until Gabriel / the recorded deeds confirm.
  for (const held of ['29000 Information Lane', '3034 Westerville Rd', '2203-2207 Northwood Dr']) {
    assert.strictEqual(asset(held).acquired, undefined, held + ' must stay undated until verified');
  }
  // The Sepich portfolio closed as one purchase: all eight of its buildings share the month.
  const sepich = ['4601 E Fifth Avenue', '4595 E Fifth Avenue', '2000-2002 Zettler Rd', '2004-2008 Zettler Rd', '2012-2026 Zettler Rd', '2800-2826 Banwick Rd', '384-398 Morrison Rd', '406-420 Morrison Rd'];
  for (const n of sepich) assert.strictEqual(asset(n).acquired, '2021-02', n);
});

test('ownership badges carry no percentages', () => {
  for (const a of ASSETS) if (a.ownership) assert.ok(!/\d/.test(a.ownership), a.name + ': ' + a.ownership);
});

test('two assets may share a parcel (4595/4601 E Fifth) but no other pin is a duplicate', () => {
  const seen = new Map();
  for (const a of ASSETS) {
    const key = a.lat + ',' + a.lng;
    seen.set(key, [...(seen.get(key) || []), a.name]);
  }
  const dupes = [...seen.values()].filter((v) => v.length > 1);
  assert.deepStrictEqual(dupes, [['4601 E Fifth Avenue', '4595 E Fifth Avenue']]);
});

test('publishing rules: no building count, no financials, no tenant names, no contacts on any page', () => {
  const files = ['portfolio.html', ...fs.readdirSync(path.join(ROOT, 'properties')).map((f) => 'properties/' + f)];
  const banned = [
    /Honeywell|Trautman|Declerq|Benson|Mangold|@krgre|@goeaston|@millerdiversified/i, // tenants / broker contacts from the source docs
    /cap rate|\bNOI\b|\bIRR\b|cash-on-cash|per square foot|\$\d/i, // financial performance (the sitewide "$1M-$10M" banner is the one allowed $)
    /fully[- ]occupied/i, // dated occupancy claim from the 2022-era Property List
    /\b(?:20|twenty) (?:buildings|properties)\b/i, // a building count (Master Workbook OI-4)
  ];
  for (const f of files) {
    // The firm-wide buy box ("$1M-$10M acquisitions": announcement bar, stats CTA) is not a property fact.
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\$1M(?:&ndash;|–|-)\$10M/g, '');
    for (const re of banned) assert.ok(!re.test(html), f + ' matches ' + re);
  }
});

test('FAQ answers are mirrored exactly in the FAQPage JSON-LD', () => {
  const html = fs.readFileSync(path.join(ROOT, 'portfolio.html'), 'utf8');
  const ld = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((o) => o['@type'] === 'FAQPage');
  assert.ok(ld, 'FAQPage JSON-LD present');
  const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const visible = [...html.matchAll(/<div class="faq-item__answer">\s*<p>([\s\S]*?)<\/p>/g)].map((m) => unescape(m[1]));
  assert.deepStrictEqual(ld.mainEntity.map((q) => q.acceptedAnswer.text), visible);
});
