/**
 * cookie-banner.test.mjs — proves, in a real browser, that the cookie banner stays compact.
 *
 * WHY: the banner is fixed to the bottom of every page and used to take 22-23% of a
 * 375x812 phone screen (about 37% on a 320px-wide phone) and wrapped to two rows on
 * desktop, which hid content and the home page's floating CTA. The chat launcher follows
 * the banner's live height (script.js publishes --cookie-banner-h), so it must stay clear.
 *
 * Run: npm run test:site   (needs `npm run build` and a chromium binary; PW_CHANNEL=msedge
 *      uses an installed Edge)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

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

// Bounds sit a little above what the compact layout measures (117px / 135px / 72px), so
// ordinary font drift passes and a regression to the old 181-214px layout does not.
const BANNER_LIMITS = [
  { width: 375, height: 812, maxPx: 135 },
  { width: 390, height: 844, maxPx: 135 },
  { width: 320, height: 568, maxPx: 155 },
  { width: 1280, height: 800, maxPx: 90 },
];

for (const l of BANNER_LIMITS) {
  test(`cookie banner at ${l.width}x${l.height} stays under ${l.maxPx}px, shows both buttons and leaves the chat launcher clear`, { timeout: 120_000 }, async () => {
    // Same-origin only: analytics, chat and maps must not make this flaky.
    const context = await browser.newContext({ viewport: { width: l.width, height: l.height } });
    await context.route('**/*', (route) => (route.request().url().startsWith(server.url) ? route.continue() : route.abort()));
    const page = await context.newPage();
    try {
      const response = await page.goto(server.url + '/for-brokers', { waitUntil: 'load', timeout: 60_000 });
      assert.equal(response.status(), 200);
      await page.waitForSelector('#cookieBanner.visible', { timeout: 15_000 });
      await page.waitForTimeout(500); // let the ResizeObserver publish --cookie-banner-h
      const m = await page.evaluate(() => {
        const banner = document.querySelector('#cookieBanner').getBoundingClientRect();
        const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height }; };
        return { banner: { top: banner.top, h: banner.height }, accept: box('#cookieAccept'), decline: box('#cookieDecline'), vw: innerWidth, vh: innerHeight };
      });
      assert.ok(m.banner.h <= l.maxPx, `banner is ${Math.round(m.banner.h)}px tall (limit ${l.maxPx}px)`);
      for (const [name, b] of [['Accept', m.accept], ['Decline', m.decline]]) {
        assert.ok(b && b.h >= 36, `${name} button missing or under 36px tall (${b && Math.round(b.h)}px)`);
        assert.ok(b.left >= 0 && b.right <= m.vw && b.top >= m.banner.top - 1 && b.bottom <= m.vh + 1, `${name} button is clipped by the viewport or banner`);
      }
      const pillBottom = await page.evaluate(() => { const p = document.querySelector('.ora-chat-trigger'); return p ? p.getBoundingClientRect().bottom : null; });
      if (pillBottom !== null) assert.ok(pillBottom <= m.banner.top + 1, `chat launcher (bottom ${Math.round(pillBottom)}) overlaps the banner (top ${Math.round(m.banner.top)})`);
    } finally {
      await context.close();
    }
  });
}
