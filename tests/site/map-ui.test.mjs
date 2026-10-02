/**
 * map-ui.test.mjs — the Available Space map, driven in a real browser.
 *
 * WHY: listings-ui.test.mjs deliberately aborts the map hosts, so nothing exercised
 * the map itself. It shipped with scroll-wheel zoom switched off and with pins 3-11 km
 * from the buildings they mark. This pins the interactions people actually use.
 *
 * HOW: the page is built dist/ served with the real CSP. Leaflet itself comes from
 * unpkg (real network, SRI-checked by the browser); the OSM tile server is replaced by
 * a 1x1 PNG so the test never touches it and the zoom level can be read back from the
 * tile URLs. If Leaflet cannot be fetched (offline machine) the tests skip rather
 * than fail, because that says nothing about the site.
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

/** Open the page; `tiles` is 'ok' (stub PNG) or 'fail' (abort). Returns null when Leaflet is unreachable. */
async function open({ tiles = 'ok', touch = false, extraListings = [] } = {}) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, hasTouch: touch });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === server.url) return route.continue();
    if (u.hostname === 'unpkg.com') return route.continue();
    if (u.hostname.endsWith('tile.openstreetmap.org')) return tiles === 'ok' ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : route.abort();
    return route.abort();
  });
  if (extraListings.length) {
    // test-only: append listings to the in-page LISTINGS array before the app builds its state,
    // so scenarios the live data no longer contains (e.g. two buildings on one pin) stay covered
    await page.route('**/listings.js*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== server.url) return route.continue();
      const res = await route.fetch();
      const marker = 'var filtered = LISTINGS.slice();';
      const body = await res.text();
      assert.ok(body.includes(marker), 'listings.js changed shape: update the extraListings injection point');
      await route.fulfill({ response: res, body: body.replace(marker, `LISTINGS.push(...${JSON.stringify(extraListings)}); ${marker}`) });
    });
  }
  await page.goto(`${server.url}/available-space.html`, { waitUntil: 'load' });
  const ready = await page.waitForFunction(() => window.L && document.querySelectorAll('.leaflet-marker-icon').length > 0, null, { timeout: 15_000 }).then(() => true, () => false);
  if (!ready) { await context.close(); return null; }
  await page.locator('#map').scrollIntoViewIfNeeded();
  return { page, context };
}

/** Current zoom, read from the tile URLs Leaflet is requesting (/{z}/{x}/{y}.png). */
const zoomOf = (page) => page.evaluate(() => {
  const zs = [...document.querySelectorAll('#map img.leaflet-tile')].map((i) => Number((i.src.match(/openstreetmap\.org\/(\d+)\//) || [])[1])).filter((n) => !Number.isNaN(n));
  return zs.length ? Math.max(...zs) : null;
});
const settle = async (page, ms = 900) => { await page.waitForTimeout(ms); };

const mapCenter = async (page) => {
  const b = await page.locator('#map').boundingBox();
  // far from the zoom buttons (top-left) and the attribution (bottom-right)
  return { x: b.x + b.width * 0.55, y: b.y + b.height * 0.55 };
};

test('every listing gets exactly one pin', async (t) => {
  const o = await open();
  if (!o) return t.skip('Leaflet unreachable');
  assert.equal(await o.page.locator('.leaflet-marker-icon').count(), LISTINGS.length);
  for (const p of LISTINGS) assert.equal(await o.page.locator(`.leaflet-marker-icon[title="${p.name}"]`).count(), 1, p.name);
  await o.context.close();
});

test('wheel zoom: ignored until the map is clicked, then zooms, then released when the pointer leaves', async (t) => {
  const o = await open();
  if (!o) return t.skip('Leaflet unreachable');
  const { page } = o;
  const c = await mapCenter(page);
  await page.mouse.move(c.x, c.y);
  const z0 = await zoomOf(page);
  assert.ok(z0 !== null, 'tiles requested');

  await page.mouse.wheel(0, -500);
  await settle(page);
  assert.equal(await zoomOf(page), z0, 'a scroll over an un-armed map must not zoom it (it scrolls the page)');

  await page.locator('#map').scrollIntoViewIfNeeded();
  const c2 = await mapCenter(page);
  await page.mouse.click(c2.x, c2.y);
  await page.mouse.wheel(0, -500);
  await settle(page, 1500);
  const z1 = await zoomOf(page);
  assert.ok(z1 > z0, `armed map zooms in on wheel-up (was ${z0}, now ${z1})`);

  await page.mouse.wheel(0, 500);
  await settle(page, 1500);
  assert.ok((await zoomOf(page)) < z1, 'wheel-down zooms back out');

  const zArmed = await zoomOf(page);
  await page.mouse.move(5, 5); // pointer leaves the map: wheel is released again
  await page.locator('#map').scrollIntoViewIfNeeded();
  const c3 = await mapCenter(page);
  await page.mouse.move(c3.x, c3.y);
  await page.mouse.wheel(0, -500);
  await settle(page);
  assert.equal(await zoomOf(page), zArmed, 'after the pointer left the map, wheel no longer zooms until re-armed');
  await o.context.close();
});

test('the + button reaches street level (zoom 19) and stops there', async (t) => {
  const o = await open();
  if (!o) return t.skip('Leaflet unreachable');
  const { page } = o;
  const plus = page.locator('.leaflet-control-zoom-in');
  // clicks that land mid-animation are dropped by Leaflet, so wait out each step
  for (let i = 0; i < 40 && (await plus.getAttribute('class')).indexOf('leaflet-disabled') < 0; i++) { await plus.click(); await page.waitForTimeout(450); }
  await settle(page, 1500);
  assert.equal(await zoomOf(page), 19);
  assert.ok(await page.locator('.leaflet-control-zoom-in.leaflet-disabled').count() === 1, 'zoom-in disables at the limit');
  await o.context.close();
});

test('overlapping pins share one popup so none is unreachable; a lone pin shows only itself', async (t) => {
  const z2 = LISTINGS.find((p) => p.name === '2000-2002 Zettler Rd');
  assert.ok(z2, 'fixture anchor listing present in data/listings.json');
  // synthetic neighbour on the exact same coordinates: the live data has no overlapping pair to rely on
  const z = {
    ...z2,
    id: 9001,
    name: 'Fixture Overlap Rd',
    slug: 'fixture-overlap-rd',
    desc: 'Synthetic listing that shares a pin with 2000-2002 Zettler Rd (test only).',
    loopnetId: '0',
    units: [{ suite: 'X1', sf: 1000, sfLabel: '1,000 SF', rate: '$10.00', rateType: 'NNN', use: 'Flex' }],
  };
  const o = await open({ extraListings: [z] });
  if (!o) return t.skip('Leaflet unreachable');
  const { page } = o;
  // whole-portfolio view: both buildings sit on one pin, so one click must reach both
  await page.locator(`.leaflet-marker-icon[title="${z.name}"]`).click({ force: true });
  const popup = page.locator('.leaflet-popup-content');
  await popup.waitFor();
  const text = await popup.innerText();
  assert.ok(text.includes(z.name) && text.includes(z2.name), `popup lists both overlapping properties: ${text}`);
  assert.ok((await popup.locator('.as-map-popup__details').count()) >= 2, 'each entry has its own Details button');

  // narrowed to one property the map zooms to it and the popup is just that property
  await page.fill('#searchInput', '2000-2002 Zettler');
  await settle(page, 1800);
  await page.locator(`.leaflet-marker-icon[title="${z2.name}"]`).click({ force: true });
  await popup.waitFor();
  const lone = await popup.innerText();
  assert.ok(lone.includes(z2.name) && !lone.includes(z.name), `popup shows only the selected property: ${lone}`);
  await popup.locator('.as-map-popup__details').click();
  await page.locator('#detailOverlay').waitFor({ state: 'visible' });
  await o.context.close();
});

test('touch: a two-finger pinch zooms the map in', async (t) => {
  const o = await open({ touch: true });
  if (!o) return t.skip('Leaflet unreachable');
  const { page, context } = o;
  const c = await mapCenter(page);
  const z0 = await zoomOf(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', { x: c.x, y: c.y, scaleFactor: 4, relativeSpeed: 600, gestureSourceType: 'touch' });
  await settle(page, 1800);
  const z1 = await zoomOf(page);
  assert.ok(z1 > z0, `pinch out zooms in (was ${z0}, now ${z1})`);
  await context.close();
});

test('tile server down: the map says so instead of sitting blank, and the pins still work', async (t) => {
  const o = await open({ tiles: 'fail' });
  if (!o) return t.skip('Leaflet unreachable');
  const { page } = o;
  await page.locator('#mapTileNote').waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await page.locator('#mapTileNote').innerText(), /temporarily unavailable/i);
  assert.equal(await page.locator('.leaflet-marker-icon').count(), LISTINGS.length);
  await o.context.close();
});

test('tile server up: the note stays hidden', async (t) => {
  const o = await open({ tiles: 'ok' });
  if (!o) return t.skip('Leaflet unreachable');
  await settle(o.page, 1200);
  assert.equal(await o.page.locator('#mapTileNote').isVisible(), false);
  await o.context.close();
});
