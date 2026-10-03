'use strict';
// build-listings.mjs — data/listings.json is the single source for the three
// places a listing appears: listings.js LISTINGS, the static fallback cards,
// and the listing-schema JSON-LD in available-space.html.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const load = () => import(url.pathToFileURL(path.join(ROOT, 'scripts', 'build-listings.mjs')).href);
// Frozen fixture, NOT data/listings.json: the live data changes with every sync
// PR and must never be able to break these tests.
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-listings.json'), 'utf8'));

test('committed listings.js and available-space.html are in sync with data/listings.json', async () => {
  const { checkAll } = await load();
  assert.deepStrictEqual(await checkAll(), []);
});

test('generated LISTINGS block evaluates back to the source data and is ASCII-only', async () => {
  const { renderListingsBlock } = await load();
  const block = renderListingsBlock(DATA);
  assert.ok(/^[\x00-\x7F]*$/.test(block), 'non-ASCII must be \\u-escaped');
  const ctx = {};
  vm.runInNewContext(block.replace('var LISTINGS', 'this.LISTINGS'), ctx);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.LISTINGS)), DATA);
});

test('static cards: one per property, single vs multi-unit markup, escaped text', async () => {
  const { renderCards } = await load();
  const html = renderCards(DATA);
  assert.strictEqual((html.match(/<article class="as-card"/g) || []).length, DATA.length);
  assert.strictEqual((html.match(/class="as-card__expand"/g) || []).length, 2);
  assert.ok(html.includes('1,200&ndash;2,400 SF'));
  assert.ok(html.includes('<div class="as-card__subtitle">2203 Northwood Dr</div>'));
  assert.ok(html.includes('alt="2012-2026 Zettler Rd &mdash; 1,800 SF Flex available in Columbus, OH"'));
  assert.ok(html.includes('subject=Inquiry%20-%209620%20E%20State%20Route%20350%20Suite%20107-108'));
  const evil = JSON.parse(JSON.stringify(DATA.slice(0, 1)));
  evil[0].name = 'A & <B>';
  assert.ok(renderCards(evil).includes('A &amp; &lt;B&gt;'));
});

test('JSON-LD: one Offer per unit, range floorSize, rate-type wording, unknown type throws', async () => {
  const { renderSchema } = await load();
  const schema = JSON.parse(renderSchema(DATA));
  const units = DATA.reduce((n, p) => n + p.units.length, 0);
  assert.strictEqual(schema.itemListElement.length, units);
  schema.itemListElement.forEach((li, i) => assert.strictEqual(li.position, i + 1));
  const nw = schema.itemListElement[4].item;
  assert.strictEqual(nw.itemOffered.name, 'Northwood Business Center, 2203 Northwood Dr');
  assert.deepStrictEqual(nw.itemOffered.floorSize, { '@type': 'QuantitativeValue', minValue: 1200, maxValue: 2400, unitCode: 'FTK' });
  assert.strictEqual(nw.priceSpecification.unitText, 'per SF per year, plus utilities');
  assert.strictEqual(schema.itemListElement[2].item.price, '8.00');
  const bad = JSON.parse(JSON.stringify(DATA.slice(0, 1)));
  bad[0].units[0].rateType = 'FSG';
  assert.throws(() => renderSchema(bad), /rateType/);
});

test('validate rejects a listing missing a required field', async () => {
  const { validate } = await load();
  const bad = JSON.parse(JSON.stringify(DATA));
  delete bad[1].lat;
  assert.throws(() => validate(bad), /384-398 Morrison Rd.*lat/);
  bad[1].lat = DATA[1].lat;
  bad[2].units = [];
  assert.throws(() => validate(bad), /units/);
});

test('validate rejects coordinates that are rounded guesses or outside the listing state', async () => {
  const { validate } = await load();
  const mutate = (fn) => { const bad = JSON.parse(JSON.stringify(DATA)); fn(bad[0]); return bad; };
  // 3-decimal pins are how the old map ended up 3-11 km off
  assert.throws(() => validate(mutate((p) => { p.lat = 39.957; })), /2012-2026 Zettler Rd.*4 decimals/);
  assert.throws(() => validate(mutate((p) => { p.lng = -82.96; })), /4 decimals/);
  // swapped lat/lng and a dropped minus sign both land outside Ohio
  assert.throws(() => validate(mutate((p) => { [p.lat, p.lng] = [p.lng, p.lat]; })), /outside OH/);
  assert.throws(() => validate(mutate((p) => { p.lng = Math.abs(p.lng); })), /outside OH/);
  // a pin geocoded to the wrong state (Easton MD coordinates on an OH listing)
  assert.throws(() => validate(mutate((p) => { p.lat = 38.78123; p.lng = -76.08123; })), /outside OH/);
  // a state with no bounds entry must fail loudly rather than skip the check
  assert.throws(() => validate(mutate((p) => { p.state = 'TX'; })), /no coordinate bounds/);
  assert.doesNotThrow(() => validate(JSON.parse(JSON.stringify(DATA))));
});

test('cache-buster: available-space.html loads listings.js at ?v=<hash of listings.js>', async () => {
  const { listingsVersion } = await load();
  const js = fs.readFileSync(path.join(ROOT, 'listings.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'available-space.html'), 'utf8');
  const m = /<script defer src="[/]listings[.]js[?]v=([^"]*)"/.exec(html);
  assert.ok(m, 'listings.js script tag not found');
  assert.strictEqual(m[1], listingsVersion(js));
  assert.notStrictEqual(listingsVersion(js), listingsVersion(js + ' '));
  assert.strictEqual(listingsVersion(['a', 'b'].join(String.fromCharCode(13, 10))), listingsVersion(['a', 'b'].join(String.fromCharCode(10))));
});

// A page whose content changes weekly must say so in sitemap.xml; otherwise the
// weekly LoopNet sync rewrites available-space.html while <lastmod> stays stale.
const SITEMAP = [
  '<urlset>',
  '  <url><loc>https://oxfordra.net/portfolio</loc><lastmod>2026-08-13</lastmod></url>',
  '  <url><loc>https://oxfordra.net/available-space</loc><lastmod>2026-08-12</lastmod></url>',
  '</urlset>',
  '',
];

test('stampSitemapLastmod rewrites only the target <lastmod>, preserving every other byte and the EOL style', async () => {
  const { stampSitemapLastmod } = await load();
  for (const eol of ['\n', '\r\n']) {
    const xml = SITEMAP.join(eol);
    const out = stampSitemapLastmod(xml, 'https://oxfordra.net/available-space', '2026-09-21');
    assert.strictEqual(out, xml.replace('<lastmod>2026-08-12</lastmod>', '<lastmod>2026-09-21</lastmod>'));
    assert.ok(out.includes('<lastmod>2026-08-13</lastmod>'), 'other pages untouched');
  }
});

test('stampSitemapLastmod is idempotent, and refuses a missing/duplicate loc or a non-ISO date', async () => {
  const { stampSitemapLastmod } = await load();
  const xml = SITEMAP.join('\n');
  const once = stampSitemapLastmod(xml, 'https://oxfordra.net/available-space', '2026-09-21');
  assert.strictEqual(stampSitemapLastmod(once, 'https://oxfordra.net/available-space', '2026-09-21'), once);
  assert.throws(() => stampSitemapLastmod(xml, 'https://oxfordra.net/nope', '2026-09-21'), /exactly 1/);
  assert.throws(() => stampSitemapLastmod(xml + xml, 'https://oxfordra.net/available-space', '2026-09-21'), /exactly 1/);
  assert.throws(() => stampSitemapLastmod(xml, 'https://oxfordra.net/available-space', '9/21/2026'), /ISO/);
});

test('the real sitemap.xml has exactly one stampable <loc>/<lastmod> for SITEMAP_LOC', async () => {
  const { SITEMAP_LOC, stampSitemapLastmod } = await load();
  const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  assert.doesNotThrow(() => stampSitemapLastmod(xml, SITEMAP_LOC, '2026-01-01'));
});

// The real write path, on a scratch copy of the repo files (never the working tree).
function scratchRoot() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'build-listings-'));
  fs.mkdirSync(path.join(root, 'data'));
  for (const f of ['data/listings.json', 'data/portfolio.json', 'listings.js', 'available-space.html', 'portfolio.html', 'sitemap.xml']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  }
  return root;
}
const slurp = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
function drift(root) { // change one rate so the generated files no longer match
  const file = path.join(root, 'data', 'listings.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data[0].units[0].rate = data[0].units[0].rate === '$99.99' ? '$88.88' : '$99.99';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
const lastmodOf = (xml, loc) => new RegExp('<loc>' + loc + '</loc><lastmod>([^<]*)').exec(xml)[1];

test('generate(): check mode reports drift but writes nothing, sitemap included', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  drift(root);
  const before = ['listings.js', 'available-space.html', 'sitemap.xml'].map((f) => slurp(root, f));
  assert.deepStrictEqual(await generate({ write: false, root, today: '2030-01-01' }), ['listings.js', 'available-space.html']);
  assert.deepStrictEqual(['listings.js', 'available-space.html', 'sitemap.xml'].map((f) => slurp(root, f)), before);
});

test('generate(): write mode with drift stamps only the available-space <lastmod>; a second run is a no-op', async () => {
  const { generate, SITEMAP_LOC } = await load();
  const root = scratchRoot();
  const sitemap0 = slurp(root, 'sitemap.xml');
  drift(root);
  assert.deepStrictEqual(await generate({ write: true, root, today: '2030-01-01' }), ['listings.js', 'available-space.html']);
  const sitemap1 = slurp(root, 'sitemap.xml');
  assert.strictEqual(lastmodOf(sitemap1, SITEMAP_LOC), '2030-01-01');
  assert.strictEqual(sitemap1, sitemap0.replace('<loc>' + SITEMAP_LOC + '</loc><lastmod>' + lastmodOf(sitemap0, SITEMAP_LOC), '<loc>' + SITEMAP_LOC + '</loc><lastmod>2030-01-01'));
  assert.deepStrictEqual(await generate({ write: true, root, today: '2031-01-01' }), []);
  assert.strictEqual(slurp(root, 'sitemap.xml'), sitemap1, 'no drift, so the sitemap is not re-stamped');
});

// The portfolio cards' "N suites available" badges derive from listings.json, so the
// weekly sync's build-listings run has to regenerate portfolio.html as well.
test('generate(): a listing that leaves listings.json drops its portfolio badge and stamps the /portfolio <lastmod>', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  const file = path.join(root, 'data', 'listings.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const gone = data.shift(); // every suite at this property leased
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  const anchor = 'href="/available-space#' + gone.slug + '"';
  assert.ok(slurp(root, 'portfolio.html').includes(anchor), 'fixture: the portfolio page shows a badge for ' + gone.slug);
  const drifted = await generate({ write: true, root, today: '2030-01-01' });
  assert.ok(drifted.includes('portfolio.html'), 'portfolio.html must be regenerated: ' + drifted);
  assert.ok(!slurp(root, 'portfolio.html').includes(anchor), 'the badge must disappear once the listing is gone');
  assert.strictEqual(lastmodOf(slurp(root, 'sitemap.xml'), 'https://oxfordra.net/portfolio'), '2030-01-01');
  assert.deepStrictEqual(await generate({ write: true, root, today: '2031-01-01' }), [], 'idempotent');
});

// The sitemap must not depend on generator order: build-listings stamps /available-space
// only when the listings page itself changed, never for a portfolio-only drift.
test('generate(): a portfolio-only drift stamps /portfolio but not /available-space', async () => {
  const { generate, SITEMAP_LOC } = await load();
  const root = scratchRoot();
  fs.writeFileSync(path.join(root, 'portfolio.html'), slurp(root, 'portfolio.html').replace('90,000 SF</span>', '91,000 SF</span>'));
  const before = lastmodOf(slurp(root, 'sitemap.xml'), SITEMAP_LOC);
  assert.deepStrictEqual(await generate({ write: true, root, today: '2030-01-01' }), ['portfolio.html']);
  const sitemap = slurp(root, 'sitemap.xml');
  assert.strictEqual(lastmodOf(sitemap, SITEMAP_LOC), before, '/available-space did not change');
  assert.strictEqual(lastmodOf(sitemap, 'https://oxfordra.net/portfolio'), '2030-01-01');
});

test('generate(): a listing no portfolio asset claims fails the run before any file is written', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  const file = path.join(root, 'data', 'listings.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.push({ ...data[0], id: 9999, slug: 'zz-unclaimed-property', loopnetId: '1' });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  const before = ['listings.js', 'available-space.html', 'portfolio.html', 'sitemap.xml'].map((f) => slurp(root, f));
  await assert.rejects(() => generate({ write: true, root, today: '2030-01-01' }), /zz-unclaimed-property/);
  assert.deepStrictEqual(['listings.js', 'available-space.html', 'portfolio.html', 'sitemap.xml'].map((f) => slurp(root, f)), before);
});

// (An unclaimed listing in the live data is caught by the build itself, via the
// orphan check exercised above, so this test only covers the claims' own shape.)
test('every portfolio listingSlug is unique and a plausible slug', () => {
  const portfolio = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'portfolio.json'), 'utf8'));
  const claimed = portfolio.map((a) => a.listingSlug).filter(Boolean);
  assert.strictEqual(new Set(claimed).size, claimed.length, 'two portfolio assets claim the same listing');
  for (const s of claimed) assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'listingSlug ' + s);
});

test('generate(): a sitemap that cannot be stamped fails the run before any file is written', async () => {
  const { generate } = await load();
  const root = scratchRoot();
  fs.writeFileSync(path.join(root, 'sitemap.xml'), slurp(root, 'sitemap.xml').replace(/<lastmod>[^<]*<\/lastmod>/g, ''));
  drift(root);
  const before = ['listings.js', 'available-space.html'].map((f) => slurp(root, f));
  await assert.rejects(() => generate({ write: true, root, today: '2030-01-01' }), /exactly 1/);
  assert.deepStrictEqual(['listings.js', 'available-space.html'].map((f) => slurp(root, f)), before);
});
