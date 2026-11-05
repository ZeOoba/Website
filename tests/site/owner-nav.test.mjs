/**
 * owner-nav.test.mjs — owners can reach /sell-your-building from the header on every page, and the header still fits.
 *
 * WHY (2026-11-05, Gabriel's ruling): the owner-outreach letters print only "oxfordra.net", and the header had no
 * owner path, so a responding owner landed on the home page with nowhere obvious to go. The desktop label is
 * "Sellers" (beside "Brokers" and "Tenants"); "Sell Your Building" did not fit the desktop bar at any width. The
 * mobile menu uses the long form, as it already does for "Broker Network" and "Tenant Resources".
 * The layout check guards the next addition: the bar shows from 1280px, so a ninth item that overflows there would
 * push the links under the logo.
 *
 * Run: npm run test:site   (needs `npm run build` and a chromium binary; PW_CHANNEL=msedge uses an installed Edge)
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');

function pages(rel = '') {
  const out = [];
  for (const e of readdirSync(path.join(DIST, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...pages(r));
    else if (e.name.endsWith('.html')) out.push(r);
  }
  return out;
}

test('every page with the primary header links Sellers on desktop and Sell Your Building in the mobile menu', () => {
  let checked = 0;
  for (const file of pages()) {
    const html = readFileSync(path.join(DIST, file), 'utf8');
    const desk = /<div class="nav__links">([\s\S]*?)<\/div>/.exec(html);
    if (!desk || !/href="\/for-brokers"/.test(desk[1])) continue; // no primary nav, or the reduced confirmation-page nav
    checked += 1;
    const items = [...desk[1].matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    const at = items.findIndex(([href]) => href === '/sell-your-building');
    assert.ok(at >= 0, `${file}: no Sellers link in the desktop nav`);
    assert.equal(items[at][1], 'Sellers', `${file}: desktop label`);
    assert.equal(items[at - 1][0], '/for-brokers', `${file}: Sellers belongs right after Brokers`);
    const self = file === 'sell-your-building.html';
    const tag = new RegExp(`<a href="/sell-your-building" class="nav__link${self ? ' nav__link--active" aria-current="page"' : '"'}>`);
    assert.match(desk[1], tag, `${file}: ${self ? 'the owner page must mark its own link current' : 'only the owner page marks the link current'}`);
    const mobile = /<nav class="nav__mobile"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(mobile && /<a href="\/sell-your-building">Sell Your Building<\/a>/.test(mobile[1]), `${file}: mobile menu lacks Sell Your Building`);
  }
  assert.ok(checked >= 40, `expected the primary nav on 40+ pages, checked ${checked}`);
  const notFound = readFileSync(path.join(DIST, '404.html'), 'utf8');
  assert.match(notFound, /<li><a href="\/sell-your-building">Sellers<\/a><\/li>/, '404 nav lacks Sellers');
});

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

// Headless Chromium hides scrollbars, so a 1280px viewport lays out 1280px. A Windows browser at 1280px (e.g. a
// 1920x1080 laptop at 150%) still gets the desktop header (media queries count the scrollbar) but only ~1263px of
// layout: `scrollbar` narrows the fixed header by 17px to stand in for that.
for (const { width, scrollbar } of [{ width: 1280, scrollbar: 0 }, { width: 1280, scrollbar: 17 }, { width: 1440, scrollbar: 0 }]) {
  test(`the desktop header fits at ${width}px${scrollbar ? ` with a ${scrollbar}px scrollbar` : ''}: one row, clear of the logo, inside the bar`, { timeout: 120_000 }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    await ctx.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    try {
      for (const p of ['/', '/sell-your-building', '/for-brokers']) {
        await page.goto(server.url + p, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts && document.fonts.ready);
        if (scrollbar) await page.addStyleTag({ content: `.nav{right:${scrollbar}px!important}` });
        const m = await page.evaluate(() => {
          const links = document.querySelector('.nav__links');
          const bar = document.querySelector('.nav__inner');
          const inner = { right: bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight) };
          const logo = document.querySelector('.nav__logo').getBoundingClientRect();
          const items = [...links.querySelectorAll('a')].map((a) => a.getBoundingClientRect());
          const centers = items.map((r) => r.top + r.height / 2);
          return {
            shown: getComputedStyle(links).display !== 'none',
            gap: items[0].left - logo.right,
            overflow: Math.max(...items.map((r) => r.right)) - inner.right,
            // The gold CTA is taller than the links but shares their centre line; a wrapped item does not.
            centerSpread: Math.max(...centers) - Math.min(...centers),
          };
        });
        assert.ok(m.shown, `${p}: desktop links hidden at ${width}px`);
        assert.ok(m.overflow <= 0, `${p}: nav overflows the bar by ${Math.round(m.overflow)}px`);
        assert.ok(m.gap >= 16, `${p}: nav links crowd the logo (${Math.round(m.gap)}px gap)`);
        assert.ok(m.centerSpread < 8, `${p}: nav wraps onto a second row (centres ${Math.round(m.centerSpread)}px apart)`);
      }
    } finally {
      await ctx.close();
    }
  });
}

test('the 404 header keeps every label on one line: fits from 1280px, scrolls sideways below that', { timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  try {
    for (const width of [1280, 1366, 1024, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(server.url + '/404.html', { waitUntil: 'load' });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      const m = await page.evaluate(() => {
        const list = document.querySelector('.site-nav__links');
        const links = [...list.querySelectorAll('a')];
        const tallest = Math.max(...links.map((a) => a.getBoundingClientRect().height));
        const single = Math.min(...links.map((a) => a.getBoundingClientRect().height));
        return { wrappedLabel: tallest > single * 1.5, overflow: list.scrollWidth - list.clientWidth, scrolls: getComputedStyle(list).overflowX };
      });
      assert.ok(!m.wrappedLabel, `404 at ${width}px: a nav label wraps onto two lines`);
      if (width >= 1280) assert.ok(m.overflow <= 1, `404 at ${width}px: the nav does not fit (${m.overflow}px hidden)`);
      else assert.equal(m.scrolls, 'auto', `404 at ${width}px: the nav must become a sideways-scrolling strip`);
    }
  } finally {
    await ctx.close();
  }
});

test('on a short phone the open mobile menu scrolls, so its last item can be reached', { timeout: 120_000 }, async () => {
  // ~550px is what an iPhone SE-class Safari shows; opening the menu locks the page behind it, so the menu must scroll.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 550 }, isMobile: true, hasTouch: true });
  await ctx.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  try {
    await page.goto(server.url + '/', { waitUntil: 'load' });
    await page.click('.nav__mobile-btn');
    const m = await page.evaluate(() => {
      const menu = document.getElementById('mobileNav');
      menu.scrollTop = menu.scrollHeight;
      const last = menu.lastElementChild.getBoundingClientRect();
      return { open: menu.classList.contains('is-open'), lastBottom: last.bottom, vh: innerHeight, overflowY: getComputedStyle(menu).overflowY };
    });
    assert.ok(m.open, 'the menu did not open');
    assert.equal(m.overflowY, 'auto', 'the open menu must scroll on its own');
    assert.ok(m.lastBottom <= m.vh, `the last menu item ends at ${Math.round(m.lastBottom)}px, below the ${m.vh}px viewport`);
  } finally {
    await ctx.close();
  }
});
