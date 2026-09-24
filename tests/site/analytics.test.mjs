// Main-thread guards from the 2026-09-24 PageSpeed desktop audit (Performance 89,
// TBT 250 ms the only non-green metric).
//
// Each test pins one finding so it cannot quietly come back:
//   #1  gtag.js (177 KiB) parsed and ran on the main thread: two long tasks
//       (193 + 167 ms). The old "defer to interaction or 3s" loader did not help
//       the lab score, because Lighthouse's simulator collapses timer delays and
//       still placed gtag inside the load window. GA4 now runs in a Partytown
//       web worker.
//   #2  Forced reflow: script.js read hero.offsetHeight at DOMContentLoaded
//       (in a requestIdleCallback that can fire before the first paint). Nothing
//       read the value: the nav "scrolled" threshold receives it by value before
//       the measure runs.
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const GA_ID = 'G-YDSX0RW5HC';
const SKIP_DIRS = new Set(['dist', 'node_modules', 'scripts', 'tests', 'evals', 'docs', 'netlify', 'data']);

function htmlFiles(dir = ROOT, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || (!rel && SKIP_DIRS.has(name))) continue;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...htmlFiles(abs, r));
    else if (name.endsWith('.html')) out.push(r);
  }
  return out;
}

// Parse every <script ...>body</script> into { attrs, body, index }.
function scripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-z-]+)(?:=("([^"]*)"|'([^']*)'|[^\s>]+))?/gi)) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[2] ?? '';
    }
    return { attrs, body: m[2], index: m.index };
  });
}

// Every published page except the internal Netlify Forms shells (*-form.html)
// must carry GA; deriving the list from ID matches would let a page silently
// lose its loader.
const GA_PAGES = htmlFiles().filter((f) => !/-form\.html$/.test(f));
const PT_SNIPPET = 'assets/partytown/partytown.js';
const PT_BANNER = existsSync(path.join(ROOT, PT_SNIPPET)) ? read(PT_SNIPPET).match(/Partytown (\d+\.\d+\.\d+)/)?.[1] : undefined;

test('GA4 is installed on every public page (sanity: the page list is not empty)', () => {
  assert.ok(GA_PAGES.length >= 20, `only ${GA_PAGES.length} pages carry ${GA_ID}`);
});

test('#1 gtag.js never loads on the main thread: it runs only as a text/partytown script', () => {
  const bad = [];
  for (const f of GA_PAGES) {
    const html = read(f);
    const s = scripts(html);
    const gtagSrc = s.filter((x) => /googletagmanager\.com\/gtag\/js/.test(x.attrs.src || ''));
    if (gtagSrc.length !== 1) bad.push(`${f}: ${gtagSrc.length} gtag.js <script src> tags (want exactly 1)`);
    else if (gtagSrc[0].attrs.type !== 'text/partytown') bad.push(`${f}: gtag.js <script src> is type="${gtagSrc[0].attrs.type || ''}", not text/partytown`);
    // The old loader built the tag in JS; any script that injects gtag.js by hand is a regression.
    for (const x of s) {
      if (x.attrs.type !== 'text/partytown' && /googletagmanager|gtag\/js/.test(x.body)) bad.push(`${f}: a main-thread script references googletagmanager/gtag.js (hand-built loader?)`);
    }
    // page_view comes solely from gtag('config'); exactly one, inside the worker.
    const cfg = s.filter((x) => x.body.includes(`gtag('config','${GA_ID}')`));
    if (cfg.length !== 1 || cfg[0].attrs.type !== 'text/partytown') bad.push(`${f}: want exactly one gtag('config') and it must be text/partytown (found ${cfg.length})`);
  }
  assert.deepEqual(bad, []);
});

test('#1 Partytown is configured before its snippet loads, forwards gtag + dataLayer.push, and matches the vendored version', () => {
  assert.ok(PT_BANNER, 'assets/partytown/partytown.js has no "Partytown x.y.z" banner');
  const bad = [];
  for (const f of GA_PAGES) {
    const s = scripts(read(f));
    const cfg = s.find((x) => /\bpartytown\s*=\s*\{/.test(x.body));
    const snip = s.find((x) => /^\/assets\/partytown\/partytown\.js\?v=/.test(x.attrs.src || ''));
    if (!cfg) { bad.push(`${f}: no partytown={...} config`); continue; }
    if (!snip) { bad.push(`${f}: no /assets/partytown/partytown.js snippet`); continue; }
    if (cfg.index > snip.index) bad.push(`${f}: partytown config comes after the snippet`);
    if (!/lib:'\/assets\/partytown\/'/.test(cfg.body)) bad.push(`${f}: partytown lib is not '/assets/partytown/'`);
    if (!/forward:\[[^\]]*'dataLayer\.push'[^\]]*'gtag'/.test(cfg.body)) bad.push(`${f}: partytown does not forward dataLayer.push and gtag`);
    const v = snip.attrs.src.split('?v=')[1];
    if (v !== PT_BANNER) bad.push(`${f}: snippet ?v=${v} but vendored Partytown is ${PT_BANNER}`);
  }
  assert.deepEqual(bad, []);
});

test('#1 the Partytown runtime ships: lib files are under a published dir, and the CSP allows its same-origin sandbox iframe', () => {
  for (const f of ['partytown.js', 'partytown-sw.js', 'partytown-media.js', 'LICENSE']) {
    assert.ok(existsSync(path.join(ROOT, 'assets/partytown', f)), `assets/partytown/${f} is missing`);
  }
  assert.ok(PT_BANNER, `${PT_SNIPPET} has no "Partytown x.y.z" banner`);
  const sw = read('assets/partytown/partytown-sw.js');
  assert.match(sw, new RegExp(`Partytown ${PT_BANNER.replace(/\./g, '\\.')}\\b`), 'partytown-sw.js is a different version than partytown.js');
  const csp = read('_headers').match(/Content-Security-Policy:([^\n]*)/)[1];
  const frameSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'));
  assert.ok(frameSrc && frameSrc.split(/\s+/).includes("'self'"), `CSP frame-src must include 'self' for the Partytown sandbox iframe (got: ${frameSrc})`);
  assert.ok(frameSrc.includes('https://www.google.com/recaptcha/'), 'CSP frame-src lost the reCAPTCHA origin');
});

test('#2 script.js takes no dead geometry read at DOMContentLoaded (forced reflow)', () => {
  const js = read('script.js');
  assert.ok(!/c\?c\.offsetHeight:400/.test(js), 'script.js reads hero offsetHeight again; nothing consumes it and it forces a layout');
  assert.ok(!/requestIdleCallback\(u\)/.test(js), 'script.js schedules its scrollspy measure with a bare requestIdleCallback that can fire before first paint; use _idle()');
});
