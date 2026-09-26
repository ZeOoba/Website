/**
 * csp-smoke.test.mjs — headless-browser CSP gate for the built site.
 *
 * THE REGRESSION THIS EXISTS FOR: `_headers`' CSP allowlist has been patched
 * reactively in this repo, one third-party integration at a time, because a CSP
 * violation is only observable as a browser console error on an origin that
 * actually sends the header. Nothing in `tests/functions/**` can see it — those
 * `require()` a module; CSP is a property of a served response plus a real
 * renderer. This test reproduces both.
 *
 * WHY IT IS NOT VACUOUS: it is served by scripts/serve-dist.mjs, which parses
 * `_headers` and applies it. Against an ordinary static server (no CSP header
 * at all) the "zero violations" assertion would pass no matter how broken the
 * allowlist was, so assertion 2 below — the response MUST carry a
 * content-security-policy header — is a required part of the gate, not a
 * nicety. Removing it turns this whole file into a no-op.
 *
 * NETWORK POLICY: real third-party requests are allowed through. CSP is
 * evaluated in the renderer BEFORE a request is dispatched, so blocking the
 * network would not silence violations for directly-referenced resources — but
 * it WOULD hide violations caused by an allowed third party injecting a further
 * resource (exactly how GTM-style tags break allowlists). Only measurement
 * beacons are aborted, so CI runs never write into production analytics.
 * Network *failures* are ignored entirely: a third-party outage degrades
 * coverage, it never turns the build red.
 *
 * Run: npm run test:site   (requires `npm run build` and a chromium binary:
 *      `npx playwright install chromium`)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

// A representative slice, not exhaustive coverage — one page per distinct
// third-party surface, which is where allowlist gaps actually come from.
const PAGES = [
  { path: '/index.html', why: 'GTM + chat widget' },
  { path: '/for-brokers.html', why: 'reCAPTCHA + broker upload' },
  { path: '/available-space.html', why: 'unpkg Leaflet + OpenStreetMap tiles' },
  { path: '/tenant-application.html', why: 'reCAPTCHA + upload script' },
];

// Aborted so CI never writes into production analytics. Script/tag hosts are
// deliberately NOT in this list — they must load for their injected resources
// to be CSP-checked.
const BEACON_HOSTS = [
  'www.google-analytics.com',
  'region1.google-analytics.com',
  'analytics.google.com',
  'stats.g.doubleclick.net',
];

// How long to let third-party scripts run after load before sampling violations.
const SETTLE_MS = 3000;

let server;
let browser;

before(async () => {
  server = await startServer({ port: 0 });
  browser = await chromium.launch();
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

for (const { path: pagePath, why } of PAGES) {
  test(`${pagePath} (${why}) loads with zero CSP violations`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Structured collection: the violation event carries the directive and the
    // blocked URI, which is what makes a failure actionable rather than "some
    // console error happened".
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          directive: e.effectiveDirective || e.violatedDirective,
          blockedURI: e.blockedURI,
          source: e.sourceFile || '(inline)',
        });
      });
    });

    // Console is the second net: it also catches violations reported from
    // frames the top-level listener never sees.
    const consoleViolations = [];
    page.on('console', (msg) => {
      if (/Content Security Policy/i.test(msg.text())) consoleViolations.push(msg.text());
    });

    await page.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      if (BEACON_HOSTS.includes(host)) return route.abort();
      return route.continue();
    });

    const response = await page.goto(server.url + pagePath, { waitUntil: 'load', timeout: 60_000 });

    // 1. The page actually rendered — a blank or errored page must not pass vacuously.
    assert.equal(response.status(), 200, `${pagePath} did not return 200`);
    const title = (await page.title()).trim();
    assert.ok(title.length > 0, `${pagePath} has an empty <title> — page did not render`);

    // 2. THE GATE ON THE GATE: a CSP header must actually be on the response.
    //    Without this, assertion 3 is meaningless. Do not delete.
    const csp = response.headers()['content-security-policy'];
    assert.ok(
      csp && csp.includes('default-src'),
      `${pagePath} was served WITHOUT a Content-Security-Policy header — the ` +
        'violation assertion below would be vacuous. Check scripts/serve-dist.mjs and dist/_headers.'
    );

    // 3. Zero violations.
    await page.waitForTimeout(SETTLE_MS);
    const eventViolations = await page.evaluate(() => window.__cspViolations || []);
    await context.close();

    const detail = [
      ...eventViolations.map((v) => `${v.directive} blocked ${v.blockedURI} (from ${v.source})`),
      ...consoleViolations,
    ];
    assert.deepEqual(
      detail,
      [],
      `${pagePath} produced ${detail.length} CSP violation(s) — add the origin to the ` +
        `matching directive in _headers, or remove the resource:\n  - ${detail.join('\n  - ')}`
    );
  }, { timeout: 120_000 });
}
