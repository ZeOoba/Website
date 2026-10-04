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
      log('event-' + a[1]);
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

async function open(pagePath, { stored } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  assert.match(log[log.length - 1], /^(config|consent-update|consent-default):granted:denied$/, `a stored Accept must end granted: ${JSON.stringify(log)}`);
  assert.ok(!log.some((l) => /:granted$/.test(l)), `advertising storage must never be granted: ${JSON.stringify(log)}`);
  assert.equal(await page.locator('#cookieBanner').isVisible(), false);
  await context.close();
});
