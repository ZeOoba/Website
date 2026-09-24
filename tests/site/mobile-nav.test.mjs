/**
 * mobile-nav.test.mjs — renders every built page in a real browser and proves
 * navigation is reachable at phone, tablet and desktop widths.
 *
 * WHY A BROWSER: site-integrity.test.mjs reads the CSS cascade statically. The
 * PR #89 merge gate (2026-09-24) showed what that cannot see: a rule elsewhere
 * with higher specificity, an !important, an overlapping query, a script.js
 * that no longer wires the button. Each left the hamburger rendering 0x0 or
 * dead while the static test passed. Here the browser computes the answer.
 *
 * THE INVARIANT, per page and width: either the nav links are visible, or the
 * hamburger has a real box, takes a click (Playwright refuses to click an
 * element that is hidden, zero-sized or covered), opens #mobileNav with
 * visible links and aria-expanded="true", and closes again on Escape.
 *
 * Run: npm run test:site   (requires `npm run build` and a chromium binary:
 *      `npx playwright install chromium`; set PW_CHANNEL=msedge to use an
 *      installed Edge instead)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

const DIST = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', 'dist');

// Two nav families ship: `.nav__links` (hidden below a breakpoint, replaced by
// the hamburger) and 404.html's `.site-nav__links` (always shown, scrolls
// sideways on phones). Either counts as the page's links.
const LINKS = '.nav__links, .site-nav__links';

// Every built page that carries a site nav (form-detection stubs do not).
function navPages(rel = '') {
  const out = [];
  for (const e of readdirSync(path.join(DIST, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...navPages(r));
    else if (e.name.endsWith('.html') && /class\s*=\s*["'](?:[^"']*\s)?(?:site-)?nav__links[\s"']/.test(readFileSync(path.join(DIST, r), 'utf8'))) out.push('/' + r);
  }
  return out.sort();
}

const WIDTHS = [375, 800, 1280];

let server;
let browser;
let pages;

before(async () => {
  pages = navPages();
  server = await startServer({ port: 0 });
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test('the built site has pages with a nav to check', () => {
  assert.ok(pages.length >= 20, `only ${pages.length} pages carry .nav__links; the scan is broken`);
});

for (const width of WIDTHS) {
  test(`at ${width}px every page's navigation is reachable (links visible, or a working hamburger)`, { timeout: 300_000 }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    // Same-origin only: the check is about our markup, CSS and script.js, and
    // third-party tags (analytics, chat, maps) must not make it flaky or noisy.
    await context.route('**/*', (route) => (route.request().url().startsWith(server.url) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const failures = [];
    let viaHamburger = 0;

    for (const pagePath of pages) {
      const fail = (msg) => failures.push(`${pagePath} @${width}px: ${msg}`);
      const response = await page.goto(server.url + pagePath, { waitUntil: 'load', timeout: 60_000 });
      if (response.status() !== 200) { fail(`HTTP ${response.status()}`); continue; }

      // "Visible" means a link a visitor can see, not just a non-hidden box.
      const linksVisible = await page.evaluate((sel) => [...document.querySelectorAll(sel)].some((box) =>
        getComputedStyle(box).visibility !== 'hidden' &&
        [...box.querySelectorAll('a[href]')].some((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; })), LINKS);
      if (linksVisible) continue;
      viaHamburger++;

      const button = page.locator('.nav__mobile-btn').first();
      const box = await button.boundingBox().catch(() => null);
      if (!box || box.width < 1 || box.height < 1) { fail(`nav links hidden and the hamburger has no box (${JSON.stringify(box)})`); continue; }
      try {
        await button.click({ timeout: 5_000 });
      } catch (err) {
        fail(`hamburger is not clickable: ${err.message.split('\n')[0]}`);
        continue;
      }

      const panel = page.locator('#mobileNav');
      const state = await panel.evaluate((el) => ({ open: el.classList.contains('is-open') })).catch(() => ({ open: false }));
      const expanded = await button.getAttribute('aria-expanded');
      const visibleLinks = await panel.locator('a[href]').evaluateAll((as) => as.filter((a) => a.getBoundingClientRect().height > 0).length).catch(() => 0);
      if (!state.open) fail('clicking the hamburger did not open #mobileNav');
      if (expanded !== 'true') fail(`aria-expanded is "${expanded}" after opening`);
      if (!(await panel.isVisible())) fail('#mobileNav is not visible after opening');
      if (visibleLinks === 0) fail('#mobileNav shows no links after opening');

      await page.keyboard.press('Escape');
      const closed = await panel.evaluate((el) => !el.classList.contains('is-open')).catch(() => false);
      if (!closed) fail('Escape did not close #mobileNav');
    }

    await context.close();
    assert.deepEqual(failures, [], `navigation unreachable at ${width}px`);
    // Phones must exercise the hamburger path, or this test proves nothing there.
    if (width === 375) assert.ok(viaHamburger >= 20, `only ${viaHamburger} pages used the hamburger at 375px`);
  });
}
