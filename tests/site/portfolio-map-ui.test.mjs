/**
 * portfolio-map-ui.test.mjs — the /portfolio map, driven in a real browser.
 *
 * WHY: a bare /portfolio?view=map opened the map at world zoom (z0, every pin stacked)
 * because the first fit ran before the container had its real size, and nothing
 * re-framed it afterwards. Pin/tile-count checks passed; only the zoom level showed it.
 *
 * HOW: same harness as map-ui.test.mjs. Built dist/ served with the real CSP; Leaflet
 * comes from unpkg (SRI-checked by the browser); the OSM tile server is a 1x1 PNG so the
 * zoom can be read from the tile URLs. If Leaflet is unreachable (offline) the tests
 * skip, because that says nothing about the site.
 *
 * Run: npm run test:site   (requires `npm run build`; PW_CHANNEL=msedge uses an installed Edge)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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

/** Open /portfolio.html with `search`/`hash`, then wait for the map's pins. Null when Leaflet is unreachable. */
async function open({ search = '', hash = '', viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ locale: 'en-US', viewport });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === server.url) return route.continue();
    if (u.hostname === 'unpkg.com') return route.continue();
    if (u.hostname.endsWith('tile.openstreetmap.org')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.abort();
  });
  await page.goto(`${server.url}/portfolio.html${search}${hash}`, { waitUntil: 'load' });
  const ready = await page.waitForFunction(() => window.L && document.querySelectorAll('#portfolioMap .leaflet-marker-icon').length > 0, null, { timeout: 15_000 }).then(() => true, () => false);
  if (!ready) { await context.close(); return null; }
  await page.waitForTimeout(1500); // let any late re-frame (resize observer, tile load) settle
  return { page, context };
}

/** Current zoom, read from the tile URLs Leaflet is requesting (/{z}/{x}/{y}.png). */
const zoomOf = (page) => page.evaluate(() => {
  const zs = [...document.querySelectorAll('#portfolioMap img.leaflet-tile')].map((i) => Number((i.src.match(/openstreetmap\.org\/(\d+)\//) || [])[1])).filter((n) => !Number.isNaN(n));
  return zs.length ? Math.max(...zs) : null;
});

/** How many distinct on-screen positions the pins occupy (all stacked on one point = world zoom). */
const distinctPins = (page) => page.evaluate(() => new Set([...document.querySelectorAll('#portfolioMap .leaflet-marker-icon')].map((p) => {
  const b = p.getBoundingClientRect();
  return `${Math.round(b.x)},${Math.round(b.y)}`;
})).size);

test('a bare /portfolio?view=map frames the portfolio, not the whole world', async (t) => {
  const s = await open({ search: '?view=map' });
  if (!s) return t.skip('Leaflet (unpkg) unreachable');
  try {
    const z = await zoomOf(s.page);
    assert.ok(z >= 5, `map opened at zoom ${z} (world view); the portfolio spans MD, OH and MO and frames at about z6`);
    assert.ok(await distinctPins(s.page) >= 10, 'pins must be spread across the map, not stacked on one point');
  } finally { await s.context.close(); }
});

// The bug itself: the first fit ran while the map container had no usable size (seen in the
// in-app browser, where the pane is laid out after the page starts), Leaflet framed the map for
// a zero-size box (world zoom), and nothing re-framed it once the real size arrived. A 1x1
// viewport at load reproduces "no size at first fit" deterministically.
test('a map first framed while its container had no size re-frames when it gets one', async (t) => {
  const s = await open({ search: '?view=map', viewport: { width: 1, height: 1 } });
  if (!s) return t.skip('Leaflet (unpkg) unreachable');
  try {
    await s.page.setViewportSize({ width: 1280, height: 900 });
    await s.page.waitForTimeout(1500);
    const z = await zoomOf(s.page);
    assert.ok(z >= 5, `map stayed at zoom ${z} after its container grew to full size`);
    assert.ok(await distinctPins(s.page) >= 10, 'pins must be spread across the map once it has a size');
  } finally { await s.context.close(); }
});

test('the deep link frames the portfolio at a phone width too', async (t) => {
  const s = await open({ search: '?view=map', viewport: { width: 390, height: 844 } });
  if (!s) return t.skip('Leaflet (unpkg) unreachable');
  try {
    const z = await zoomOf(s.page);
    assert.ok(z >= 3, `map opened at zoom ${z} on a phone`);
    assert.ok(await distinctPins(s.page) >= 5, 'pins must be spread across the map');
  } finally { await s.context.close(); }
});

test('the Map button, clicked after a normal load, frames the portfolio (baseline)', async (t) => {
  const s = await open({ search: '' }).catch(() => null);
  // A plain /portfolio load has no map yet; click the Map pill like a visitor does.
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === server.url || u.hostname === 'unpkg.com') return route.continue();
    if (u.hostname.endsWith('tile.openstreetmap.org')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.abort();
  });
  try {
    await page.goto(`${server.url}/portfolio.html`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    const ready = await page.waitForFunction(() => window.L && document.querySelectorAll('#portfolioMap .leaflet-marker-icon').length > 0, null, { timeout: 15_000 }).then(() => true, () => false);
    if (!ready) return t.skip('Leaflet (unpkg) unreachable');
    await page.waitForTimeout(1500);
    assert.ok(await zoomOf(page) >= 5);
    assert.ok(await distinctPins(page) >= 10);
  } finally {
    await context.close();
    if (s) await s.context.close();
  }
});

test('a property deep link (?view=map#slug) zooms to that building and opens its popup', async (t) => {
  const s = await open({ search: '?view=map', hash: '#55-new-plant-court' });
  if (!s) return t.skip('Leaflet (unpkg) unreachable');
  try {
    assert.equal(await zoomOf(s.page), 16);
    assert.match(await s.page.locator('.leaflet-popup-content').innerText(), /55 New Plant Court/);
  } finally { await s.context.close(); }
});

test('a property deep link loaded with no size still ends up zoomed to the building after the resize', async (t) => {
  const s = await open({ search: '?view=map', hash: '#55-new-plant-court', viewport: { width: 1, height: 1 } });
  if (!s) return t.skip('Leaflet (unpkg) unreachable');
  try {
    await s.page.setViewportSize({ width: 1280, height: 900 });
    await s.page.waitForTimeout(1500);
    assert.equal(await zoomOf(s.page), 16, 'the re-frame must keep the deep-linked building, not the whole portfolio');
    assert.match(await s.page.locator('.leaflet-popup-content').innerText(), /55 New Plant Court/);
  } finally { await s.context.close(); }
});

test('the visitor\'s own pan/zoom is not undone by a late re-frame', async (t) => {
  const s = await open({ search: '?view=map' });
  if (!s) return t.skip('Leaflet (unpkg) unreachable');
  try {
    // Click the zoom-in control, then change the window size: a resize must not re-fit over their zoom.
    const before = await zoomOf(s.page);
    await s.page.locator('#portfolioMap .leaflet-control-zoom-in').click();
    await s.page.waitForTimeout(600);
    const zoomed = await zoomOf(s.page);
    assert.ok(zoomed > before, 'the zoom control must work');
    await s.page.setViewportSize({ width: 1100, height: 900 });
    await s.page.waitForTimeout(800);
    assert.equal(await zoomOf(s.page), zoomed, 'a resize after the visitor zoomed must not re-frame the map');
  } finally { await s.context.close(); }
});
