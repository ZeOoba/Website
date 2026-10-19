/**
 * consent-mode.test.mjs — proves Google Consent Mode v2 behaves in a real
 * browser, through Partytown, on built pages.
 *
 * WHY A BROWSER: analytics.test.mjs pins the markup (consent-default.js is a
 * text/partytown script that precedes gtag.js; script.js grants only on
 * Accept). It cannot see the thing that matters: that, inside the Partytown
 * worker, the consent DEFAULT lands before gtag('config'), that a stored Accept
 * makes the visitor granted, and that Decline never does.
 *
 * Google's real gtag.js is replaced by a tiny stand-in (route.fulfill) that
 * processes dataLayer commands in order and writes each consent/config command,
 * with the consent state at that moment, to data-ga-N attributes on <html>.
 * That keeps the test offline and means NO hit ever reaches the production GA4
 * property. The stand-in mirrors what gtag.js does with Consent Mode: commands
 * are applied in dataLayer order. What this test pins is OUR ordering/state.
 *
 * Run: npm run test:site   (requires `npm run build`; PW_CHANNEL=msedge uses an
 *      installed Edge instead of the bundled Chromium)
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

// Pages that carry the banner, including two that had none before this pass.
const PAGES = ['/', '/privacy', '/markets/columbus-oh'];

const FAKE_GTAG = `(function () {
  var state = {}, n = 0, root = document.documentElement;
  function log(kind) {
    root.setAttribute('data-ga-' + n++, kind + ':' + (state.analytics_storage || 'unset') + ':' + (state.ad_storage || 'unset'));
  }
  function handle(a) {
    if (a[0] === 'consent') {
      for (var k in a[2]) state[k] = a[2][k];
      log('consent-' + a[1]);
    } else if (a[0] === 'config') {
      log('config');
    } else if (a[0] === 'event') {
      log('event-' + a[1] + (a[2] && a[2].event_label ? '[' + a[2].event_label + ']' : ''));
    }
  }
  var dl = window.dataLayer = window.dataLayer || [];
  for (var i = 0; i < dl.length; i++) handle(dl[i]);
  var push = dl.push;
  dl.push = function () {
    for (var i = 0; i < arguments.length; i++) handle(arguments[i]);
    return push.apply(dl, arguments);
  };
})();`;

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

async function open(pagePath, { stored, serviceWorkers } = {}) {
  // serviceWorkers: 'block' stops Partytown's service worker, which triggers its 10s
  // main-thread fallback (text/partytown scripts are re-inserted as normal scripts).
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...(serviceWorkers ? { serviceWorkers } : {}) });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(server.url)) return route.continue();
    if (/googletagmanager\.com\/gtag\/js/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: FAKE_GTAG });
    }
    return route.abort(); // nothing else leaves the machine, in particular no GA collect hit
  });
  if (stored) await context.addInitScript((k) => localStorage.setItem(k, 'true'), stored);
  const page = await context.newPage();
  await page.goto(server.url + pagePath, { waitUntil: 'load' });
  return { context, page };
}

// data-ga-N attributes, in order: ["consent-default:denied:denied", "config:denied:denied", ...]
const readLog = (page) =>
  page.evaluate(() =>
    document.documentElement
      .getAttributeNames()
      .filter((n) => n.startsWith('data-ga-'))
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
      .map((n) => document.documentElement.getAttribute(n)));

const waitForConfig = (page) =>
  page.waitForFunction(
    () => document.documentElement.getAttributeNames().some((n) => n.startsWith('data-ga-') && document.documentElement.getAttribute(n).startsWith('config:')),
    null,
    { timeout: 30_000 },
  );

// Click a link only once it is really there to be clicked. The site sets
// `html{scroll-behavior:smooth}` and fades `.animate-on-scroll` blocks in with a 24px
// transform transition, so right after scrollIntoView the link is still moving. A
// `force: true` click skips Playwright's stability and hit-target checks and fires at
// the coordinates computed mid-motion: under CPU load it landed on the surrounding
// <section> and no GA4 event was ever sent (the phone_click flake, 5 of 40 loaded runs).
// Wait on the page's own state instead: the rect has been identical for 5 consecutive
// frames AND the element at its centre is the link (or inside it). If something such as
// the fixed cookie banner ever covers the link, this wait times out and says what is on
// top, rather than clicking the cover. The final click is forced only because the
// settle check has already done Playwright's actionability work.
async function clickSettled(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const handle = await locator.elementHandle();
  await page.waitForFunction((el) => {
    const r = el.getBoundingClientRect();
    const key = [r.left, r.top, r.width, r.height].join(',');
    const s = window.__settle && window.__settle.el === el ? window.__settle : (window.__settle = { el, key: '', n: 0 });
    if (s.key === key) s.n++; else { s.key = key; s.n = 0; }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return s.n >= 5 && !!hit && el.contains(hit);
  }, handle, { polling: 'raf', timeout: 15_000 }).catch(async (err) => {
    const seen = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { rect: [r.left, r.top, r.width, r.height].map(Math.round), scrollY: Math.round(window.scrollY), hit: hit ? `${hit.tagName}.${hit.getAttribute('class')}` : null };
    }).catch(() => 'element detached');
    throw new Error(`link never settled under the pointer: ${JSON.stringify(seen)}: ${err.message.split('\n')[0]}`);
  });
  await locator.click({ force: true });
}

for (const pagePath of PAGES) {
  test(`${pagePath}: a first-time visitor is denied before GA4 configures, and the banner is shown`, { timeout: 60_000 }, async () => {
    const { context, page } = await open(pagePath);
    await waitForConfig(page);
    const log = await readLog(page);
    const iDefault = log.findIndex((l) => l.startsWith('consent-default:'));
    const iConfig = log.findIndex((l) => l.startsWith('config:'));
    assert.ok(iDefault >= 0, `no consent default reached the worker: ${JSON.stringify(log)}`);
    assert.ok(iDefault < iConfig, `consent default must precede config: ${JSON.stringify(log)}`);
    assert.equal(log[iDefault], 'consent-default:denied:denied');
    assert.equal(log[iConfig], 'config:denied:denied', 'config must see analytics denied for a first-time visitor');
    assert.ok(!log.some((l) => /:granted:/.test(l)), `nothing may be granted before the visitor accepts: ${JSON.stringify(log)}`);
    assert.ok(await page.locator('#cookieBanner').isVisible(), 'banner must be visible so the visitor can choose');
    await context.close();
  });
}

test('Accept grants analytics (and only analytics) and hides the banner', { timeout: 60_000 }, async () => {
  const { context, page } = await open('/privacy');
  await waitForConfig(page);
  await page.locator('#cookieAccept').click();
  await page.waitForFunction(
    () => document.documentElement.getAttributeNames().some((n) => n.startsWith('data-ga-') && document.documentElement.getAttribute(n) === 'consent-update:granted:denied'),
    null,
    { timeout: 15_000 },
  );
  const log = await readLog(page);
  assert.ok(!log.some((l) => /:granted$/.test(l)), `advertising storage must never be granted: ${JSON.stringify(log)}`);
  await page.waitForSelector('#cookieBanner', { state: 'hidden', timeout: 5_000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('oxford-cookies-accepted')), 'true');
  await context.close();
});

test('main-thread window.gtag() calls (conversion events, consent updates) reach the Partytown worker', { timeout: 60_000 }, async () => {
  // Regression: the inline `function gtag(){}` declaration is private to its worker
  // script, so forwarded calls threw "reading 'apply'" and were silently lost.
  const { context, page } = await open('/contact');
  await waitForConfig(page);
  await page.evaluate(() => window.gtag('event', 'ora_forward_probe', { event_category: 'test' }));
  await page.waitForFunction(
    () => document.documentElement.getAttributeNames().some((n) => n.startsWith('data-ga-') && document.documentElement.getAttribute(n).startsWith('event-ora_forward_probe:')),
    null,
    { timeout: 15_000 },
  );
  await context.close();
});

test('phone, email, PDF and CTA clicks each emit one GA4 event through the worker', { timeout: 90_000 }, async () => {
  const { context, page } = await open('/for-brokers');
  await waitForConfig(page);
  // Keep the browser on the page: a tel:/mailto:/PDF navigation would leave it. This
  // listener is added after script.js's, so the tracking handler has already run.
  await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a[href]')) e.preventDefault(); }));
  // Log entries look like "event-<name>[<label>]:<analytics>:<ads>"; pass a label to pin it.
  const expectEvent = (name, label) =>
    page.waitForFunction(
      (want) => document.documentElement.getAttributeNames().some((a) => a.startsWith('data-ga-') && document.documentElement.getAttribute(a).startsWith(want)),
      `event-${name}${label ? `[${label}]` : ''}`,
      { timeout: 15_000 },
    ).catch(async (err) => {
      throw new Error(`expected event-${name}${label ? `[${label}]` : ''} but the log is ${JSON.stringify(await readLog(page))}: ${err.message.split('\n')[0]}`);
    });
  await page.locator('.subpage-hero a.btn--gold[href="#broker-network"]').click();
  await expectEvent('cta_click', 'submit_deal');
  await clickSettled(page, page.locator('a[href^="tel:"]').first());
  await expectEvent('phone_click');
  // GA4 auto-redacts email-shaped values to "(redacted)", so a firm mailbox is labeled by
  // its name only (info), and any other address is never named (external).
  await clickSettled(page, page.locator('a[href="mailto:info@oxfordra.net"]').first());
  await expectEvent('email_click', 'info');
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'mailto:visitor@example.com';
    a.textContent = 'visitor';
    document.body.appendChild(a);
  });
  // dispatchEvent rather than a coordinate click: the fixed cookie banner covers the page bottom.
  await page.locator('a[href="mailto:visitor@example.com"]').dispatchEvent('click');
  await expectEvent('email_click', 'external');
  const log = await readLog(page);
  assert.ok(!log.some((l) => /@/.test(l)), `an email address reached the analytics layer: ${JSON.stringify(log)}`);
  await context.close();
  const home = await open('/');
  await waitForConfig(home.page);
  await home.page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a[href]')) e.preventDefault(); }));
  await clickSettled(home.page, home.page.locator('a[href$=".pdf"]').first());
  await home.page.waitForFunction(
    () => document.documentElement.getAttributeNames().some((a) => a.startsWith('data-ga-') && document.documentElement.getAttribute(a).startsWith('event-pdf_download')),
    null,
    { timeout: 15_000 },
  );
  await home.context.close();
});

test('Decline never grants anything', { timeout: 60_000 }, async () => {
  const { context, page } = await open('/');
  await waitForConfig(page);
  await page.locator('#cookieDecline').click();
  await page.waitForSelector('#cookieBanner', { state: 'hidden', timeout: 5_000 });
  await page.waitForTimeout(1_500); // give any (wrongly) pending update time to land
  const log = await readLog(page);
  assert.ok(!log.some((l) => /granted/.test(l)), `Decline must leave consent denied: ${JSON.stringify(log)}`);
  assert.equal(await page.evaluate(() => localStorage.getItem('oxford-cookies-declined')), 'true');
  await context.close();
});

test('a returning visitor who accepted ends up granted for analytics only, and sees no banner', { timeout: 60_000 }, async () => {
  const { context, page } = await open('/', { stored: 'oxford-cookies-accepted' });
  await waitForConfig(page);
  await page.waitForTimeout(1_000);
  const log = await readLog(page);
  assert.equal(log[0], 'consent-default:granted:denied', `a stored Accept must start granted at the first hit, not just eventually: ${JSON.stringify(log)}`);
  assert.equal(log.find((l) => l.startsWith('config:')), 'config:granted:denied');
  assert.ok(!log.some((l) => /:granted$/.test(l)), `advertising storage must never be granted: ${JSON.stringify(log)}`);
  assert.equal(await page.locator('#cookieBanner').isVisible(), false);
  await context.close();
});

// Partytown falls back to the main thread when its service worker cannot start (SW blocked,
// privacy modes, enterprise policy). There it re-inserts external text/partytown scripts
// asynchronously but runs inline ones at once, so the consent default has to be inline
// with config. This is the exact failure the independent review reproduced.
test('fallback mode (no service worker): a first-time visitor is still denied before config', { timeout: 90_000 }, async () => {
  const { context, page } = await open('/privacy', { serviceWorkers: 'block' });
  await page.waitForFunction(
    () => document.documentElement.getAttributeNames().some((n) => n.startsWith('data-ga-') && document.documentElement.getAttribute(n).startsWith('config:')),
    null,
    { timeout: 45_000 },
  );
  const log = await readLog(page);
  const iDefault = log.findIndex((l) => l.startsWith('consent-default:'));
  const iConfig = log.findIndex((l) => l.startsWith('config:'));
  assert.ok(iDefault >= 0 && iDefault < iConfig, `consent default must precede config in fallback mode: ${JSON.stringify(log)}`);
  assert.equal(log[iConfig], 'config:denied:denied');
  assert.ok(!log.some((l) => /:granted:/.test(l)), JSON.stringify(log));
  await context.close();
});

test('fallback mode (no service worker): a stored Accept starts granted', { timeout: 90_000 }, async () => {
  const { context, page } = await open('/', { stored: 'oxford-cookies-accepted', serviceWorkers: 'block' });
  await page.waitForFunction(
    () => document.documentElement.getAttributeNames().some((n) => n.startsWith('data-ga-') && document.documentElement.getAttribute(n).startsWith('config:')),
    null,
    { timeout: 45_000 },
  );
  const log = await readLog(page);
  const iDefault = log.findIndex((l) => l.startsWith('consent-default:'));
  const iConfig = log.findIndex((l) => l.startsWith('config:'));
  assert.ok(iDefault >= 0 && iDefault < iConfig, `consent default must precede config in fallback mode: ${JSON.stringify(log)}`);
  assert.equal(log[iDefault], 'consent-default:granted:denied', JSON.stringify(log));
  assert.equal(log[iConfig], 'config:granted:denied', `config must see the stored Accept: ${JSON.stringify(log)}`);
  assert.ok(!log.some((l) => /:granted$/.test(l)), `advertising storage must never be granted: ${JSON.stringify(log)}`);
  await context.close();
});
