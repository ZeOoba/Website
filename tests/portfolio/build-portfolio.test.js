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

test('no ownership structure is ever shown (Gabriel, 2026-10-02: no joint venture / partnership badge anywhere)', () => {
  for (const a of ASSETS) assert.strictEqual(a.ownership, undefined, a.name + ' carries an ownership field');
  const files = ['portfolio.html', ...fs.readdirSync(path.join(ROOT, 'properties')).map((f) => 'properties/' + f)];
  for (const f of files) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/joint[- ]venture|\bpartnership\b|\bJV\b|co-?invest/i.test(html), f + ' mentions an ownership structure');
  }
});

test('two assets may share a parcel (4595/4601 E Fifth) but no other pin is a duplicate', () => {
  const seen = new Map();
  for (const a of ASSETS) {
    const key = a.lat + ',' + a.lng;
    seen.set(key, [...(seen.get(key) || []), a.name]);
  }
  // Sorted, so reordering cards in the data file is not a failure.
  const dupes = [...seen.values()].filter((v) => v.length > 1).map((v) => [...v].sort());
  assert.deepStrictEqual(dupes, [['4595 E Fifth Avenue', '4601 E Fifth Avenue']]);
});

test('validateAssets rejects data that would silently drop, mangle or collide cards', async () => {
  const { validateAssets } = await load();
  const base = asset('9050 Red Branch Road');
  const bad = (patch, extra = []) => () => validateAssets([{ ...base, ...patch }, ...extra]);
  assert.throws(bad({ market: 'Maryland ' }), /market must be one of/, 'a trailing space would drop the card from the grid');
  assert.throws(bad({ market: undefined }), /market must be one of/);
  assert.throws(bad({ sf: '90,000' }), /positive integer/, 'a string SF would publish NaN');
  assert.throws(bad({ sf: 0 }), /positive integer/);
  assert.throws(bad({ sf: 1.5 }), /positive integer/);
  assert.throws(bad({ name: '!!!' }), /empty slug/);
  assert.throws(bad({}, [{ ...base, name: '9050 Red-Branch Road' }]), /also used by/, 'two names with one slug collide on id and page file');
});

test('JSON-LD cannot be broken out of its <script> element by a "<" in the data', async () => {
  const { renderPortfolioPage } = await load();
  const src = fs.readFileSync(path.join(ROOT, 'portfolio.html'), 'utf8').replace(/\r\n/g, '\n');
  const listings = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listings.json'), 'utf8'));
  const hostile = ASSETS.map((a, i) => (i === 0 ? { ...a, name: '9050 Red Branch Road</script><script>alert(1)//' } : a));
  const out = renderPortfolioPage(src, hostile, listings);
  assert.ok(!out.includes('</script><script>alert(1)'), 'the closing tag must not survive in any JSON-LD block');
  assert.ok(out.includes('\\u003c/script'), 'it is escaped, not dropped');
});

// The real write path on a scratch copy of the generated files (never the working tree).
const scratchRoots = [];
test.after(() => { for (const r of scratchRoots) fs.rmSync(r, { recursive: true, force: true }); });
function scratchRoot() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'build-portfolio-'));
  scratchRoots.push(root);
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'properties'));
  for (const f of ['data/portfolio.json', 'data/listings.json', 'portfolio.html', 'sitemap.xml']) fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  for (const f of fs.readdirSync(path.join(ROOT, 'properties'))) fs.copyFileSync(path.join(ROOT, 'properties', f), path.join(root, 'properties', f));
  return root;
}
const slurp = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

test('generate(): the drift gate catches a hand-edited property page and writes nothing in check mode', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  assert.deepStrictEqual(await generate({ write: false, root }), [], 'the committed pages are in sync');
  const file = 'properties/55-new-plant-court.html';
  fs.writeFileSync(path.join(root, file), slurp(root, file).replace('9,500 SF', '99,000 SF'));
  const edited = slurp(root, file);
  assert.deepStrictEqual(await generate({ write: false, root }), [file]);
  assert.strictEqual(slurp(root, file), edited, 'check mode must not rewrite it');
});

test('generate(): write mode repairs only the drifted page and stamps its sitemap <lastmod>; a rerun is a no-op', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  const file = 'properties/55-new-plant-court.html';
  const good = slurp(root, file);
  fs.writeFileSync(path.join(root, file), good.replace('9,500 SF', '99,000 SF'));
  assert.deepStrictEqual(await generate({ write: true, root, today: '2030-01-01' }), [file]);
  assert.strictEqual(slurp(root, file), good);
  const lastmod = (loc) => new RegExp('<loc>' + loc + '</loc><lastmod>([^<]*)').exec(slurp(root, 'sitemap.xml'))[1];
  assert.strictEqual(lastmod('https://oxfordra.net/properties/55-new-plant-court'), '2030-01-01');
  assert.notStrictEqual(lastmod('https://oxfordra.net/portfolio'), '2030-01-01', 'an unchanged page keeps its date');
  assert.deepStrictEqual(await generate({ write: true, root, today: '2031-01-01' }), []);
});

test('generate(): each file keeps its own line endings: a CRLF working copy shows no drift and stays CRLF; an LF one stays LF', async () => {
  const { generate } = await load();
  for (const eol of ['\r\n', '\n']) {
    const root = scratchRoot();
    const files = ['portfolio.html', 'sitemap.xml', ...fs.readdirSync(path.join(root, 'properties')).map((f) => 'properties/' + f)];
    for (const f of files) fs.writeFileSync(path.join(root, f), slurp(root, f).replace(/\r\n/g, '\n').replace(/\n/g, eol));
    const label = JSON.stringify(eol);
    assert.deepStrictEqual(await generate({ write: false, root }), [], 'no false drift on ' + label);
    const file = 'properties/55-new-plant-court.html';
    fs.writeFileSync(path.join(root, file), slurp(root, file).replace('9,500 SF', '99,000 SF'));
    assert.deepStrictEqual(await generate({ write: true, root, today: '2030-01-01' }), [file]);
    const fixed = slurp(root, file);
    assert.ok(!fixed.includes('99,000 SF'), 'repaired ' + label);
    assert.strictEqual(fixed.replace(/\r\n/g, '').includes('\n'), eol === '\n', 'a rewrite keeps ' + label);
    assert.strictEqual(fixed.includes('\r\n'), eol === '\r\n', 'a rewrite keeps ' + label);
    assert.strictEqual(slurp(root, 'sitemap.xml').includes('\r\n'), eol === '\r\n', 'the sitemap keeps ' + label);
  }
});

test('generate(): a page nothing generates any more fails the run (it would ship and stay in the sitemap)', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  const assets = JSON.parse(slurp(root, 'data/portfolio.json'));
  delete assets.find((a) => a.name === '3540 E Fifth Avenue').detail;
  fs.writeFileSync(path.join(root, 'data', 'portfolio.json'), JSON.stringify(assets, null, 1));
  const before = slurp(root, 'portfolio.html');
  await assert.rejects(() => generate({ write: true, root }), /3540-e-fifth-avenue\.html/);
  assert.strictEqual(slurp(root, 'portfolio.html'), before, 'nothing is written when the run fails');
});

test('the sitemap date for /portfolio is stamped by this generator too, whichever generator runs first', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  fs.writeFileSync(path.join(root, 'portfolio.html'), slurp(root, 'portfolio.html').replace('90,000 SF</span>', '91,000 SF</span>')); // inside the generated grid
  const drifted = await generate({ write: true, root, today: '2030-01-01' });
  assert.ok(drifted.includes('portfolio.html'));
  assert.match(slurp(root, 'sitemap.xml'), /<loc>https:\/\/oxfordra\.net\/portfolio<\/loc><lastmod>2030-01-01</);
});

test('publishing rules: no building count, no financials, no tenant names, no contacts on any page', () => {
  const files = ['portfolio.html', ...fs.readdirSync(path.join(ROOT, 'properties')).map((f) => 'properties/' + f)];
  const banned = [
    /Honeywell|Trautman|Declerq|Benson|Mangold|@krgre|@goeaston|@millerdiversified/i, // tenants / broker contacts from the source docs
    /cap rate|\bNOI\b|\bIRR\b|cash-on-cash|per square foot|\$\d/i, // financial performance (the sitewide "$1M-$10M" banner is the one allowed $)
    // Occupancy and income claims: Gabriel's rule is physical specs + acquisition years only.
    /occupan|occupied|net operating income|waiting list|nearly doubled|lease-up|below[- ]market|market[- ]rate/i,
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
