/**
 * listings-ui.test.mjs — the Available Space page, driven in a real browser.
 *
 * WHY: listings.js (774 lines: filters, sort, stats bar, cards, table, detail overlay)
 * had no test at all; tests/listings/ covers only the generator and the LoopNet sync.
 * It already shipped one silent wrong-answer bug (a size filter that summed all units
 * against the minimum and compared only the first unit to the maximum, so three 4,000 SF
 * suites showed under "10,000+ SF"), found by reading the code, not by CI. A wrong
 * filter here shows a prospective tenant the wrong space and never errors.
 *
 * HOW: the oracle is an independent re-implementation of the rules written in this
 * file from data/listings.json (the source the page is generated from), so the test
 * follows the data as listings change and does not just echo listings.js back at itself.
 * Everything runs against the built dist/ served with the real CSP. Third-party hosts
 * (Leaflet, map tiles) are aborted: the map is out of scope, the list UI must work
 * without it.
 *
 * Run: npm run test:site   (requires `npm run build`; PW_CHANNEL=msedge uses an installed Edge)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const LISTINGS = JSON.parse(readFileSync(path.join(ROOT, 'data', 'listings.json'), 'utf8'));

// ---- oracle ---------------------------------------------------------------------
const hi = (u) => u.sfMax || u.sf;
const totalSF = (p) => p.units.reduce((s, u) => s + hi(u), 0);
const RANGES = { '0-2000': [0, 2000], '2000-5000': [2000, 5000], '5000-10000': [5000, 10000], '10000-999999': [10000, 999999] };
const inRange = (p, [min, max]) => p.units.some((u) => hi(u) >= min && u.sf <= max);
const matchesQuery = (p, q) => {
  q = q.toLowerCase().trim();
  return !q || [p.name, p.city, p.category, p.subtitle || ''].some((s) => s.toLowerCase().includes(q));
};
const expected = ({ q = '', market = '', type = '', size = '', sort = 'featured' } = {}) => {
  let list = LISTINGS.filter((p) => matchesQuery(p, q) && (!market || p.market === market) && (!type || p.category === type) && (!size || inRange(p, RANGES[size])));
  if (sort === 'sf-desc') list = [...list].sort((a, b) => totalSF(b) - totalSF(a));
  else if (sort === 'sf-asc') list = [...list].sort((a, b) => totalSF(a) - totalSF(b));
  else if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  return list;
};
const unitCount = (list) => list.reduce((s, p) => s + p.units.length, 0);
const statText = (list) => {
  const rates = list.flatMap((p) => p.units.map((u) => parseFloat(u.rate.replace('$', '')))).filter((r) => !Number.isNaN(r));
  const range = !rates.length ? '—' : Math.min(...rates) === Math.max(...rates) ? `$${Math.min(...rates).toFixed(2)}` : `$${Math.min(...rates).toFixed(2)} – $${Math.max(...rates).toFixed(2)}`;
  return {
    listings: String(unitCount(list)),
    sf: `${list.reduce((s, p) => s + totalSF(p), 0).toLocaleString('en-US')} SF`,
    range,
    count: `${list.length} properties · ${unitCount(list)} spaces`,
  };
};

// ---- harness --------------------------------------------------------------------
let server;
let browser;

before(async () => {
  server = await startServer({ port: 0 });
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

async function open(hash = '') {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
  await page.goto(`${server.url}/available-space.html${hash}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#listingsPanel .as-card').length > 0);
  return { page, context };
}
const cardIds = (page) => page.$$eval('#listingsPanel .as-card', (els) => els.map((e) => Number(e.dataset.id)));
const stats = (page) => page.evaluate(() => ({
  listings: document.getElementById('statListings').textContent,
  sf: document.getElementById('statSF').textContent,
  range: document.getElementById('statRange').textContent,
  count: document.getElementById('resultsCount').textContent,
}));
const ids = (list) => list.map((p) => p.id);

// ---- tests ----------------------------------------------------------------------
test('the fixture is rich enough to mean something: several markets, types, and a multi-unit property', () => {
  assert.ok(LISTINGS.length >= 3);
  assert.ok(new Set(LISTINGS.map((p) => p.market)).size >= 2, 'need 2+ markets to exercise the market filter');
  assert.ok(new Set(LISTINGS.map((p) => p.category)).size >= 2, 'need 2+ types to exercise the type filter');
  assert.ok(LISTINGS.some((p) => p.units.length > 1), 'need a multi-unit property');
});

test('on load every listing renders in data order, and the stats bar matches', async () => {
  const { page, context } = await open();
  assert.deepEqual(await cardIds(page), ids(expected()));
  assert.deepEqual(await stats(page), statText(expected()));
  await context.close();
});

test('size filter: each range shows exactly the properties with ANY single unit in range (the shipped "3 x 4,000 SF under 10,000+" bug)', async () => {
  const { page, context } = await open();
  for (const size of Object.keys(RANGES)) {
    await page.selectOption('#filterSize', size);
    assert.deepEqual(await cardIds(page), ids(expected({ size })), `size ${size}`);
    assert.deepEqual(await stats(page), statText(expected({ size })), `stats for size ${size}`);
  }
  await page.selectOption('#filterSize', '');
  assert.deepEqual(await cardIds(page), ids(expected()), 'clearing the size filter restores everything');
  await context.close();
});

// The live data may never contain the shape that broke the filter, so pin it with a fixture:
// listings.js is served with its LISTINGS block swapped for three purpose-built properties.
test('size filter, shipped bug pinned with a fixture: three 4,000 SF suites are NOT "10,000+ SF"; a 9,000-12,000 SF range unit IS', async () => {
  const unit = (suite, sf, sfMax) => ({ suite, sf, ...(sfMax ? { sfMax } : {}), sfLabel: `${sf.toLocaleString('en-US')} SF`, rate: '$8.00', rateType: 'NNN', use: 'Industrial' });
  const base = { city: 'Columbus', state: 'OH', market: 'Columbus', category: 'Industrial', lat: 39.95, lng: -82.96, img: '/images/17-warehouse-columbus-external.jpg', imgW: 700, desc: 'fixture' };
  const fixture = [
    { ...base, id: 101, name: 'Three Small Suites', slug: 'three-small', units: [unit('A', 4000), unit('B', 4000), unit('C', 4000)] },
    { ...base, id: 102, name: 'One Large Suite', slug: 'one-large', units: [unit('A', 12000)] },
    { ...base, id: 103, name: 'Range Unit', slug: 'range-unit', units: [unit('A', 9000, 12000)] },
  ];
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
  // dist/, not the source file: this must exercise exactly what gets served.
  const source = readFileSync(path.join(ROOT, 'dist', 'listings.js'), 'utf8');
  const swapped = source.replace(/var LISTINGS = \[[\s\S]*?\n {2}\];/, `var LISTINGS = ${JSON.stringify(fixture)};`);
  assert.notEqual(swapped, source, 'could not find the LISTINGS block in listings.js to swap');
  await page.route('**/listings.js*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: swapped }));
  await page.goto(`${server.url}/available-space.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#listingsPanel .as-card').length > 0);
  assert.deepEqual(await cardIds(page), [101, 102, 103]);
  await page.selectOption('#filterSize', '10000-999999');
  assert.deepEqual(await cardIds(page), [102, 103], 'a property of three 4,000 SF suites must not appear under 10,000+ SF');
  await page.selectOption('#filterSize', '2000-5000');
  assert.deepEqual(await cardIds(page), [101], 'only the 4,000 SF suites fit 2,000-5,000 SF (a 9,000-12,000 SF range unit does not)');
  await page.selectOption('#filterSize', '5000-10000');
  assert.deepEqual(await cardIds(page), [103], 'the 9,000-12,000 SF range unit overlaps 5,000-10,000 SF');
  await context.close();
});

test('market and type filters, alone and combined, match the oracle', async () => {
  const { page, context } = await open();
  const markets = [...new Set(LISTINGS.map((p) => p.market))];
  const types = [...new Set(LISTINGS.map((p) => p.category))];
  for (const market of markets) {
    await page.selectOption('#filterMarket', market);
    assert.deepEqual(await cardIds(page), ids(expected({ market })), `market ${market}`);
    for (const type of types) {
      await page.selectOption('#filterType', type);
      assert.deepEqual(await cardIds(page), ids(expected({ market, type })), `market ${market} + type ${type}`);
    }
    await page.selectOption('#filterType', '');
  }
  await context.close();
});

test('the market and type dropdowns offer exactly the markets and types in the data, sorted', async () => {
  const { page, context } = await open();
  const options = (sel) => page.$$eval(`${sel} option`, (os) => os.map((o) => o.value).filter(Boolean));
  assert.deepEqual(await options('#filterMarket'), [...new Set(LISTINGS.map((p) => p.market))].sort());
  assert.deepEqual(await options('#filterType'), [...new Set(LISTINGS.map((p) => p.category))].sort());
  await context.close();
});

test('search matches name, city, type and subtitle, case-insensitively and trimmed; a miss shows "Clear all", which restores the page', async () => {
  const { page, context } = await open();
  const withSubtitle = LISTINGS.find((p) => p.subtitle);
  const queries = ['  ' + LISTINGS[0].name.split(' ')[0].toUpperCase() + '  ', LISTINGS[0].city.toLowerCase(), LISTINGS[0].category, withSubtitle && withSubtitle.subtitle.split(' ').slice(-2).join(' ')].filter(Boolean);
  for (const q of queries) {
    await page.fill('#searchInput', q);
    assert.deepEqual(await cardIds(page), ids(expected({ q })), `search "${q}"`);
  }
  await page.fill('#searchInput', 'zzzz-no-such-property');
  assert.equal((await cardIds(page)).length, 0);
  assert.equal(await page.locator('.as-no-results').count(), 1, 'a search with no results must say so');
  assert.equal((await stats(page)).count, '0 properties · 0 spaces');
  await page.click('.as-no-results__reset');
  assert.deepEqual(await cardIds(page), ids(expected()));
  assert.equal(await page.inputValue('#searchInput'), '', 'Clear all must also reset the search box');
  assert.equal(await page.inputValue('#filterMarket'), '');
  await context.close();
});

test('sorting: size descending, size ascending and name match the oracle, including with a filter applied', async () => {
  const { page, context } = await open();
  for (const sort of ['sf-desc', 'sf-asc', 'name']) {
    await page.selectOption('#sortBy', sort);
    assert.deepEqual(await cardIds(page), ids(expected({ sort })), `sort ${sort}`);
  }
  const market = LISTINGS[0].market;
  await page.selectOption('#filterMarket', market);
  await page.selectOption('#sortBy', 'sf-desc');
  assert.deepEqual(await cardIds(page), ids(expected({ market, sort: 'sf-desc' })), 'filter + sort together');
  await page.selectOption('#sortBy', 'featured');
  assert.deepEqual(await cardIds(page), ids(expected({ market })), 'back to featured order');
  await context.close();
});

test('the stats bar follows every filter (units, total SF using each unit\'s maximum, and the rate range)', async () => {
  const { page, context } = await open();
  for (const opts of [{ market: LISTINGS[0].market }, { type: LISTINGS[LISTINGS.length - 1].category }, { size: '2000-5000' }, { q: LISTINGS[0].city }]) {
    if (opts.market) await page.selectOption('#filterMarket', opts.market);
    if (opts.type) await page.selectOption('#filterType', opts.type);
    if (opts.size) await page.selectOption('#filterSize', opts.size);
    if (opts.q) await page.fill('#searchInput', opts.q);
    assert.deepEqual(await stats(page), statText(expected(opts)), JSON.stringify(opts));
    await page.evaluate(() => window.resetFilters());
  }
  assert.deepEqual(await stats(page), statText(expected()), 'reset returns the full stats');
  await context.close();
});

test('table view lists one row per unit (property name only on its first row) and cards view comes back', async () => {
  const { page, context } = await open();
  await page.click('#viewTable');
  assert.equal(await page.locator('.as-table tbody tr').count(), unitCount(expected()));
  const named = await page.$$eval('.as-table tbody tr', (rows) => rows.filter((r) => r.querySelector('.as-table__name').textContent.trim()).map((r) => Number(r.dataset.id)));
  assert.deepEqual(named, ids(expected()), 'exactly one named row per property, in order');
  await page.click('#viewCards');
  assert.deepEqual(await cardIds(page), ids(expected()));
  await context.close();
});

test('a multi-unit card expands to show every unit and collapses again (aria-expanded stays truthful)', async () => {
  const { page, context } = await open();
  const p = LISTINGS.find((x) => x.units.length > 1);
  const toggle = page.locator(`.as-card__expand[data-id="${p.id}"]`);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  const opened = page.locator(`.as-card[data-id="${p.id}"]`);
  assert.equal(await page.locator(`.as-card[data-id="${p.id}"] .as-unit`).count(), p.units.length);
  assert.equal(await page.locator(`.as-card__expand[data-id="${p.id}"]`).getAttribute('aria-expanded'), 'true');
  assert.ok(await opened.evaluate((el) => el.classList.contains('as-card--expanded')));
  await page.locator(`.as-card__expand[data-id="${p.id}"]`).click();
  assert.equal(await page.locator(`.as-card__expand[data-id="${p.id}"]`).getAttribute('aria-expanded'), 'false');
  await context.close();
});

test('detail overlay: opens from a card, shows the property, traps Tab focus, closes on Escape and restores scrolling', async () => {
  const { page, context } = await open();
  const p = LISTINGS[0];
  await page.click(`.as-card[data-id="${p.id}"] .as-card__title`);
  const overlay = page.locator('#detailOverlay');
  assert.ok(await overlay.isVisible(), 'overlay did not open');
  assert.match(await page.locator('#detailBody').innerText(), new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await page.locator('#detailBody .detail-unit-row').count(), p.units.length);
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'page behind the overlay must not scroll');
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.getElementById('detailOverlay').contains(document.activeElement)), `focus escaped the overlay on Tab #${i + 1}`);
  }
  await page.keyboard.press('Escape');
  assert.ok(!(await overlay.isVisible()), 'Escape did not close the overlay');
  assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'scrolling was not restored');
  await context.close();
});

test('deep link: /available-space#<slug> opens that property\'s detail on load', async () => {
  const p = LISTINGS.find((x) => x.slug) || LISTINGS[0];
  const { page, context } = await open(`#${p.slug}`);
  assert.ok(await page.locator('#detailOverlay').isVisible(), `#${p.slug} did not open a detail overlay`);
  assert.match(await page.locator('#detailBody h2').innerText(), new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await context.close();
});
