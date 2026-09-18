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
  bad[1].lat = 1;
  bad[2].units = [];
  assert.throws(() => validate(bad), /units/);
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
