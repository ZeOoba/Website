/**
 * csp-all-pages.test.mjs — every built page, real browser, real CSP header, zero
 * script violations.
 *
 * csp-smoke.test.mjs samples four pages because its job is third-party allowlist gaps.
 * This one exists for the hash list: script-src no longer allows 'unsafe-inline', so a
 * page whose inline script does not match a hash in _headers would be silently dead on
 * the live site. csp-hashes.test.mjs proves the hashes match the source text; this proves
 * a real HTML parser hands the browser the same bytes (entities, line endings, whitespace
 * inside <script>) and that nothing on any page, including scripts that other scripts
 * inject, needs the loophole back.
 *
 * Third parties are aborted here (csp-smoke covers what they inject); this is about the
 * site's own inline code.
 *
 * Run: npm run test:site   (requires `npm run build`; PW_CHANNEL=msedge uses an installed Edge)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

const DIST = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', 'dist');

function builtPages(rel = '') {
  const out = [];
  for (const e of readdirSync(path.join(DIST, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...builtPages(r));
    else if (e.name.endsWith('.html') && !/-form\.html$/.test(e.name)) out.push('/' + r);
  }
  return out.sort();
}

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

test('every built page loads with no script-src violation and its inline scripts actually run', async () => {
  const pages = builtPages();
  assert.ok(pages.length >= 20, `only ${pages.length} pages found in dist/; run npm run build`);
  const bad = [];
  for (const pagePath of pages) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI === 'inline' ? 'an inline script' : e.blockedURI} (sample: ${(e.sample || '').slice(0, 60).replace(/\s+/g, ' ')})`);
      });
    });
    const consoleViolations = [];
    page.on('console', (msg) => { if (/Content Security Policy/i.test(msg.text()) && /script-src/i.test(msg.text())) consoleViolations.push(msg.text().slice(0, 200)); });
    await page.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));

    const response = await page.goto(server.url + pagePath, { waitUntil: 'load', timeout: 60_000 });
    assert.equal(response.status(), 200, `${pagePath} did not return 200`);
    assert.ok(/script-src/.test(response.headers()['content-security-policy'] || ''), `${pagePath} served without a script-src: the check would be vacuous`);
    await page.waitForTimeout(700);
    const violations = (await page.evaluate(() => window.__cspViolations || [])).concat(consoleViolations);
    if (violations.length) bad.push(`${pagePath}: ${[...new Set(violations)].join(' | ')}`);
    await context.close();
  }
  assert.deepEqual(bad, [], 'inline scripts blocked by the CSP (regenerate hashes with: node scripts/csp-hashes.mjs --write)');
}, { timeout: 300_000 });

// Partytown's documented fallback: when its service worker cannot start (blocked, private
// mode, an old browser) it waits fallbackTimeout (10 s) and re-inserts the text/partytown
// blocks as ordinary inline scripts. That path needs the same hashes and is the one no
// other test reaches, because a normal run never falls back.
test('Partytown fallback: with service workers blocked, the re-inserted gtag block still runs under the strict policy', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
  await page.goto(server.url + '/about.html', { waitUntil: 'load' });
  await page.waitForTimeout(11_500);
  const state = await page.evaluate(() => ({ violations: window.__cspViolations, configured: (window.dataLayer || []).some((a) => a && a[0] === 'config') }));
  await context.close();
  assert.deepEqual(state.violations, [], 'the Partytown fallback script was blocked by the CSP');
  assert.ok(state.configured, "gtag('config') never ran on the main thread: the fallback did not execute, or its script was blocked silently");
}, { timeout: 60_000 });

// A blocked inline script leaves no error a visitor could see, so also check that one
// known inline script per kind did run: the nav's Escape handler lives in script.js (external),
// but the FAQ accordion and the hero counters are inline on these pages.
test('inline behaviour survives the strict policy: an inline FAQ accordion still opens', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
  await page.goto(server.url + '/for-brokers.html', { waitUntil: 'load' });
  const trigger = page.locator('.faq-item__trigger').first();
  await trigger.scrollIntoViewIfNeeded();
  const before = await trigger.getAttribute('aria-expanded');
  await trigger.click();
  const after = await trigger.getAttribute('aria-expanded');
  await context.close();
  assert.equal(before, 'false');
  assert.equal(after, 'true', 'the FAQ accordion did not open: its inline script was probably blocked');
});
