// Guards for the 2026-10-04 consistency + plumbing pass (ChatGPT "10/10" review
// adjudication). Each test pins one finding so it cannot quietly come back:
//   P1 legacy Squarespace/Wix URLs that returned 404 now 301 to a built page
//   P2 markets/index no longer says "three markets" (2 core + Kansas City holding)
//   P3 before/after sliders are not role="img" parents of an interactive slider
//   P4 scrollable regions are keyboard-focusable and named; no empty <th>
//   P5 breadcrumb links on the resources pages do not rely on colour alone
//   P6 /for-brokers carries a Submit a Deal button inside the hero (mobile fold)
//   P7 every property page is linked from outside /portfolio; Track Record links
//      its case studies to their property pages
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function redirectRules() {
  return read('_redirects')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));
}

const pageFileFor = (urlPath) =>
  urlPath === '/' ? 'index.html' : urlPath.endsWith('/') ? `${urlPath.slice(1)}index.html` : `${urlPath.slice(1)}.html`;

test('P1 legacy URLs 301 to a page that ships', () => {
  const rules = redirectRules();
  const catchAll = rules.findIndex(([from]) => from === '/*');
  const legacy = {
    '/about-us': '/about',
    '/gallery-3': '/portfolio',
    '/sell': '/sell-your-building',
    '/portfolio-1/4595-east-fifth-pbabg': '/properties/4595-e-fifth-avenue',
  };
  for (const [from, to] of Object.entries(legacy)) {
    const i = rules.findIndex(([f]) => f === from);
    assert.ok(i >= 0, `missing redirect for ${from}`);
    assert.ok(i < catchAll, `${from} must come before the /* catch-all`);
    assert.equal(rules[i][1], to, `${from} should redirect to ${to}`);
    assert.equal(rules[i][2], '301', `${from} must be a 301`);
    assert.ok(existsSync(path.join(ROOT, pageFileFor(to))), `${to} does not resolve to a source page`);
  }
});

test('P2 markets/index states two core markets plus a Kansas City holding', () => {
  const html = read('markets/index.html');
  assert.doesNotMatch(html, /three markets/i, 'markets/index must not say "three markets"');
  assert.match(html, /two core markets/i);
  assert.match(html, /Kansas City holding/i);
  assert.match(html, /href="\/properties\/9620-state-route-350"/, 'Kansas City card should link to its property page');
});

test('P3 before/after slider containers are role=group, never role=img', () => {
  for (const file of ['index.html', 'track-record.html']) {
    const html = read(file);
    const containers = [...html.matchAll(/<div class="ba-slider"[^>]*>/g)].map((m) => m[0]);
    assert.ok(containers.length > 0, `${file}: expected a .ba-slider`);
    for (const c of containers) {
      assert.doesNotMatch(c, /role="img"/, `${file}: a role=img parent of the slider is nested-interactive`);
      assert.match(c, /role="group"/);
      assert.match(c, /aria-label="[^"]+"/);
    }
  }
});

test('P4 scrollable regions are focusable and named; the comparison table has no empty header cell', () => {
  const sell = read('sell-your-building.html');
  const wrap = sell.match(/<div class="owner-compare-wrap[^>]*>/)?.[0] ?? '';
  assert.match(wrap, /tabindex="0"/);
  assert.match(wrap, /role="region"/);
  assert.match(wrap, /aria-label="[^"]+"/);
  assert.doesNotMatch(sell, /<th>(?:&nbsp;|\s)*<\/th>/, 'empty <th> in the owner comparison table');
  const about = read('about.html');
  const track = about.match(/<div class="history-timeline__track"[^>]*>/)?.[0] ?? '';
  assert.match(track, /tabindex="0"/);
  assert.match(track, /role="region"/);
  assert.match(track, /aria-label="[^"]+"/);
});

test('P5 resources breadcrumb links are underlined (not colour-only)', () => {
  const dir = path.join(ROOT, 'resources');
  const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const html = read(`resources/${f}`);
    const rule = html.match(/\.breadcrumb-nav a\{[^}]*\}/)?.[0];
    if (!rule) continue;
    assert.match(rule, /text-decoration:underline/, `resources/${f}: breadcrumb link relies on colour alone`);
  }
});

test('P6 /for-brokers hero has a Submit a Deal button that targets the intake form', () => {
  const html = read('for-brokers.html');
  const hero = html.match(/<div class="subpage-hero__content">[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(hero, /<a href="#broker-network" class="btn btn--gold">Submit a Deal<\/a>/);
  assert.match(html, /<section[^>]*id="broker-network"/, 'the #broker-network anchor must exist');
});

test('P7 every property page is linked from outside /portfolio; Track Record links its case studies', () => {
  const props = readdirSync(path.join(ROOT, 'properties')).filter((f) => f.endsWith('.html'));
  assert.ok(props.length >= 18);
  const pages = [];
  const walk = (dir) => {
    for (const f of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${f.name}` : f.name;
      if (f.isDirectory()) {
        if (['properties', 'markets', 'resources'].includes(f.name)) walk(rel);
      } else if (f.name.endsWith('.html')) pages.push(rel);
    }
  };
  walk('');
  for (const p of props) {
    const slug = p.replace(/\.html$/, '');
    const linkers = pages.filter(
      (f) => f !== `properties/${p}` && f !== 'portfolio.html' && read(f).includes(`href="/properties/${slug}"`),
    );
    assert.ok(linkers.length >= 1, `properties/${p} is linked only from /portfolio (near-orphan)`);
  }
  const tr = read('track-record.html');
  const linked = new Set([...tr.matchAll(/href="\/properties\/([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.ok(linked.size >= 6, `track-record should link its case studies to property pages, found ${linked.size}`);
});

// W3 — case-study facts (Gabriel's 2026-10-04 rulings): 3540's ~12% is yield on
// total cost (price + renovation), not a going-in cap; Fairground's equity
// multiple / IRR are unverifiable and are not published or quotable by the chatbot.
test('P8 3540 ~12% is labeled yield on cost; Fairground shows no unverifiable multiple or IRR', () => {
  const home = read('index.html');
  const tr = read('track-record.html');
  for (const [name, html] of [['index.html', home], ['track-record.html', tr]]) {
    assert.doesNotMatch(html, /going-in cap/i, `${name}: "going-in cap" mislabels a yield on cost`);
    assert.doesNotMatch(html, /cap-rate expansion/i, `${name}: "cap-rate expansion" reads as a value loss`);
  }
  assert.match(home, /~12%<\/span><span class="metric-tile__label">Yield on Cost</);
  assert.match(tr, /~12%<\/span>\s*<span class="metric__label">Yield on Cost</);
  const fair = tr.slice(tr.indexOf('<h3>Fairground Village Center</h3>'));
  assert.ok(fair.length > 100, 'Fairground card must exist');
  assert.doesNotMatch(fair, /Equity Multiple|>IRR</i, 'Fairground must not publish an equity multiple or IRR');
  assert.doesNotMatch(read('netlify/edge-functions/chat.ts'), /cap rate, IRR|equity multiple/i);
  assert.doesNotMatch(read('scripts/meta.md'), /equity multiple, IRR/i);
});
