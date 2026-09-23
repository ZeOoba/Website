// Structural integrity guards from the PR #85 merge-gate test-validity audit
// (2026-09-23). That audit mutated copies of the site and found breakage that
// passed every existing validator. Each test below pins one of those classes:
//   - ItemList numberOfItems that disagrees with its itemListElement count
//   - structured data dropped from a page outside REQUIRED_JSONLD_PAGES
//   - a sitemap <lastmod> that is malformed, not a real date, or in the future
//   - an in-page #fragment link whose target id is gone
//   - og:image pointing at a missing file, or og:image:width/height that lie
//   - a second <h1>
//   - an unbalanced or misnested </section> (and the other block containers)
//   - a srcset / imagesrcset candidate that is missing or has the wrong `w`
//   - nav links hidden at a breakpoint with no working hamburger to replace them
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { imageSize } from './lib/image-size.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const { jsonLdBlocks } = createRequire(import.meta.url)('../../scripts/validate-jsonld.js');

function htmlFiles(rel = '') {
  const skip = new Set(['dist', 'node_modules', '.netlify', '.git', 'tests', 'evals', 'scripts', 'netlify', 'docs', '.claude', 'data']);
  const out = [];
  for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!skip.has(e.name)) out.push(...htmlFiles(r)); }
    else if (e.name.endsWith('.html')) out.push(r);
  }
  return out.sort();
}
const PAGES = htmlFiles();

const SITEMAP_FILES = [...read('sitemap.xml').matchAll(/<loc>https:\/\/oxfordra\.net(\/[^<]*)<\/loc>/g)].map(({ 1: p }) =>
  p === '/' ? 'index.html' : p.endsWith('/') ? `${p.slice(1)}index.html` : `${p.slice(1)}.html`
);

// Parse attributes into a map; never assume attribute order or quote style.
function attrs(tag) {
  const map = {};
  const inner = tag.replace(/^<[\w-]+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    map[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return map;
}
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => ({ ...attrs(m[0]), _index: m.index }));

// Markup with comments and raw-text elements blanked out (same length, so
// indexes still map to line numbers). Their contents are not DOM structure.
function markup(html) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<(script|style|template|textarea)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (_, open, _n, body, close) => open + blank(body) + close);
}
const lineOf = (html, index) => html.slice(0, index).split('\n').length;

const localFile = (url, page) => {
  const clean = url.replace(/^https:\/\/oxfordra\.net/, '').split(/[?#]/)[0];
  return clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(page), clean);
};

function jsonLd(html) {
  return [...html.matchAll(jsonLdBlocks())].map((m) => JSON.parse(m[1]));
}
function* walkJson(node) {
  if (Array.isArray(node)) for (const n of node) yield* walkJson(n);
  else if (node && typeof node === 'object') {
    yield node;
    for (const v of Object.values(node)) yield* walkJson(v);
  }
}

// ── Structured data ──────────────────────────────────────────────────────────

test('every ItemList has sequential positions and a numberOfItems (when declared) equal to its element count', () => {
  let lists = 0;
  for (const page of PAGES) {
    for (const node of walkJson(jsonLd(read(page)))) {
      if (node['@type'] !== 'ItemList') continue;
      lists++;
      const items = node.itemListElement ?? [];
      assert.ok(items.length > 0, `${page}: ItemList "${node.name}" has no itemListElement`);
      if ('numberOfItems' in node) {
        assert.equal(node.numberOfItems, items.length, `${page}: ItemList "${node.name}" numberOfItems ${node.numberOfItems} ≠ ${items.length} elements`);
      }
      assert.deepEqual(items.map((i) => i.position), items.map((_, n) => n + 1), `${page}: ItemList "${node.name}" positions are not 1..${items.length}`);
    }
  }
  assert.ok(lists >= 4, `expected at least the 4 known ItemLists, found ${lists}`);
});

// Every indexable page's structured-data types, pinned. verify-jsonld.mjs only
// requires SOME block on six pages, so emptying markets/ or tenant-resources,
// or dropping a FAQPage anywhere, passed. A page added to the sitemap must be
// added here too.
const EXPECTED_JSONLD_TYPES = {
  'index.html': ['FAQPage', 'Organization', 'WebSite'],
  'about.html': ['BreadcrumbList', 'FAQPage', 'Organization'],
  'portfolio.html': ['BreadcrumbList', 'ItemList'],
  'markets/index.html': ['BreadcrumbList', 'ItemList'],
  'markets/columbus-oh.html': ['BreadcrumbList', 'FAQPage'],
  'markets/maryland.html': ['BreadcrumbList', 'FAQPage'],
  'track-record.html': ['BreadcrumbList'],
  'for-brokers.html': ['BreadcrumbList', 'FAQPage'],
  'sell-your-building.html': ['BreadcrumbList', 'FAQPage', 'Service'],
  'resources/index.html': ['BreadcrumbList', 'ItemList'],
  'resources/selling-industrial-building-without-a-broker.html': ['Article', 'BreadcrumbList', 'FAQPage'],
  'resources/how-industrial-buildings-are-valued.html': ['Article', 'BreadcrumbList', 'FAQPage'],
  'resources/1031-exchange-industrial-property-guide.html': ['Article', 'BreadcrumbList', 'FAQPage'],
  'resources/industrial-building-sale-document-checklist.html': ['Article', 'BreadcrumbList', 'FAQPage'],
  'available-space.html': ['BreadcrumbList', 'FAQPage', 'ItemList'],
  'tenant-resources.html': ['BreadcrumbList', 'FAQPage'],
  'contact.html': ['BreadcrumbList'],
  'privacy.html': ['BreadcrumbList'],
  'terms.html': ['BreadcrumbList'],
};

test('every sitemap page carries its pinned set of JSON-LD types', () => {
  assert.deepEqual(Object.keys(EXPECTED_JSONLD_TYPES).sort(), [...SITEMAP_FILES].sort(), 'EXPECTED_JSONLD_TYPES and sitemap.xml list different pages');
  for (const [page, expected] of Object.entries(EXPECTED_JSONLD_TYPES)) {
    const types = jsonLd(read(page)).flatMap((b) => (b['@graph'] ? b['@graph'].map((g) => g['@type']) : [b['@type']])).flat();
    assert.deepEqual(types.sort(), expected, `${page} JSON-LD types`);
  }
});

// ── Sitemap ─────────────────────────────────────────────────────────────────

// Found by PR #85's round-2 merge gate: `2099-12-31`, `2026-23-09` and
// `2026-9-3` all passed, and seo.test.mjs QC-2 compares dates as strings, which
// is only sound once every date is zero-padded ISO. The future bound is "today
// (UTC) plus one day of timezone slack": it only tightens as time passes, so a
// tree that passes today can never start failing tomorrow.
test('every sitemap <url> has one real, zero-padded ISO <lastmod> that is not in the future', () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const urls = [...read('sitemap.xml').matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  assert.equal(urls.length, SITEMAP_FILES.length, 'every <url> must carry exactly one <loc>');
  for (const url of urls) {
    const loc = url.match(/<loc>([^<]*)<\/loc>/)?.[1];
    const mods = [...url.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map((m) => m[1]);
    assert.equal(mods.length, 1, `${loc} has ${mods.length} <lastmod> elements`);
    const [lastmod] = mods;
    assert.match(lastmod, /^\d{4}-\d{2}-\d{2}$/, `${loc} lastmod "${lastmod}" is not YYYY-MM-DD`);
    const roundTrip = new Date(`${lastmod}T00:00:00Z`);
    assert.ok(!Number.isNaN(roundTrip.getTime()) && roundTrip.toISOString().slice(0, 10) === lastmod, `${loc} lastmod "${lastmod}" is not a real calendar date`);
    assert.ok(lastmod <= tomorrow, `${loc} lastmod ${lastmod} is in the future`);
  }
});

// ── Links and media ─────────────────────────────────────────────────────────

test('every #fragment link points at an id that exists on its target page', () => {
  const idCache = new Map();
  const idsOf = (page) => {
    if (!idCache.has(page)) {
      const html = markup(read(page));
      idCache.set(page, new Set([...html.matchAll(/<[\w-]+\b[^>]*?\s(?:id|name)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1])));
    }
    return idCache.get(page);
  };
  const broken = [];
  let checked = 0;
  for (const page of PAGES) {
    const html = markup(read(page));
    for (const a of tags(html, 'a')) {
      const href = a.href ?? '';
      const hash = href.indexOf('#');
      if (hash < 0) continue;
      const fragment = decodeURIComponent(href.slice(hash + 1));
      if (fragment === '' || fragment === 'top') continue; // both scroll to the top natively
      const base = href.slice(0, hash);
      if (/^[a-z]+:/i.test(base) && !base.startsWith('https://oxfordra.net')) continue; // external site
      let target = page;
      if (base) {
        const f = localFile(base, page);
        target = f === '' || f.endsWith('/') ? `${f}index.html` : f.endsWith('.html') ? f : `${f}.html`;
      }
      checked++;
      if (!existsSync(path.join(ROOT, target))) broken.push(`${page}:${lineOf(html, a._index)} ${href} → ${target} does not exist`);
      else if (!idsOf(target).has(fragment)) broken.push(`${page}:${lineOf(html, a._index)} ${href} → no id="${fragment}" in ${target}`);
    }
  }
  assert.ok(checked > 0, 'found no fragment links at all; the scan is broken');
  assert.deepEqual(broken, [], 'fragment links with no target');
});

test('og:image exists and its declared og:image:width/height match the real file', () => {
  for (const page of PAGES) {
    const metas = tags(read(page), 'meta');
    const prop = (p) => metas.find((m) => m.property === p || m.name === p)?.content;
    for (const key of ['og:image', 'twitter:image']) {
      const url = prop(key);
      if (url === undefined) continue;
      assert.match(url, /^https:\/\/oxfordra\.net\//, `${page} ${key} must be an absolute oxfordra.net URL: ${url}`);
      const file = localFile(url, page);
      assert.ok(existsSync(path.join(ROOT, file)), `${page} ${key} → ${file} does not exist`);
      if (key !== 'og:image') continue;
      const [w, h] = [prop('og:image:width'), prop('og:image:height')];
      assert.equal(w === undefined, h === undefined, `${page} declares only one of og:image:width/height`);
      if (w === undefined) continue;
      const real = imageSize(path.join(ROOT, file));
      assert.deepEqual({ width: Number(w), height: Number(h) }, { width: real.width, height: real.height }, `${page} og:image:width/height vs ${file}`);
    }
  }
});

test('every srcset / imagesrcset candidate exists and its `w` descriptor is the file\'s real width', () => {
  const problems = [];
  let candidates = 0;
  for (const page of PAGES) {
    const html = markup(read(page));
    for (const tag of [...tags(html, 'img'), ...tags(html, 'source'), ...tags(html, 'link')]) {
      for (const set of [tag.srcset, tag.imagesrcset].filter(Boolean)) {
        for (const candidate of set.split(',').map((c) => c.trim()).filter(Boolean)) {
          const [url, descriptor = '1x'] = candidate.split(/\s+/);
          if (/^[a-z]+:/i.test(url) && !url.startsWith('https://oxfordra.net')) continue;
          candidates++;
          const file = localFile(url, page);
          const where = `${page}:${lineOf(html, tag._index)} ${url}`;
          if (!existsSync(path.join(ROOT, file))) { problems.push(`${where} does not exist`); continue; }
          const w = descriptor.match(/^(\d+)w$/)?.[1];
          if (!w) continue;
          const real = imageSize(path.join(ROOT, file)).width;
          if (Number(w) !== real) problems.push(`${where} declares ${w}w but is ${real}px wide`);
        }
      }
    }
  }
  assert.ok(candidates > 0, 'found no srcset candidates at all; the scan is broken');
  assert.deepEqual(problems, [], 'bad srcset candidates');
});

// ── Document structure ──────────────────────────────────────────────────────

test('a page with <main> has exactly one <h1>; no page has more than one', () => {
  for (const page of PAGES) {
    const html = markup(read(page));
    const h1s = (html.match(/<h1\b/gi) ?? []).length;
    if (/<main\b/i.test(html)) assert.equal(h1s, 1, `${page} has ${h1s} <h1> elements`);
    else assert.ok(h1s <= 1, `${page} has ${h1s} <h1> elements`);
  }
});

const CONTAINERS = ['section', 'main', 'article', 'nav', 'header', 'footer', 'aside', 'form', 'div', 'ul', 'ol', 'table'];

test('block containers (section, main, div, …) are balanced and properly nested', () => {
  const re = new RegExp(`<(/?)(${CONTAINERS.join('|')})\\b[^>]*>`, 'gi');
  for (const page of PAGES) {
    const html = markup(read(page));
    const stack = [];
    for (const m of html.matchAll(re)) {
      const [, closing, raw] = m;
      const tag = raw.toLowerCase();
      if (!closing) { stack.push({ tag, line: lineOf(html, m.index) }); continue; }
      const open = stack.pop();
      assert.ok(open, `${page}:${lineOf(html, m.index)} </${tag}> closes nothing`);
      assert.equal(open.tag, tag, `${page}:${lineOf(html, m.index)} </${tag}> closes <${open.tag}> opened on line ${open.line}`);
    }
    assert.deepEqual(stack.map((s) => `<${s.tag}> line ${s.line}`), [], `${page} leaves containers unclosed`);
  }
});

// ── Mobile navigation ───────────────────────────────────────────────────────

// Top-level @media blocks of a stylesheet, with their rules.
function mediaRules(css) {
  const out = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = css.indexOf('@media'); i !== -1; i = css.indexOf('@media', i + 1)) {
    const open = css.indexOf('{', i);
    let depth = 1, j = open + 1;
    while (depth && j < css.length) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0, j++;
    const query = css.slice(i + 6, open).replace(/\s+/g, '');
    for (const [, selectors, decls] of css.slice(open + 1, j - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ query, selectors: selectors.split(',').map((s) => s.trim()), display: decls.match(/display\s*:\s*([\w-]+)/)?.[1] });
    }
    i = j;
  }
  return out;
}

// script.js binds the hamburger by these two hooks; a page that hides its nav
// links must provide both, or small screens get no navigation at all.
const TOGGLE_CLASS = 'nav__mobile-btn';
const MOBILE_NAV_ID = 'mobileNav';
// Pages that already ship this defect. Fixing one makes the test fail until its
// entry is removed, so the list can only shrink.
const KNOWN_NAV_GAPS = new Set(['application-received.html']);

test('a page that hides its nav links at a breakpoint shows a wired hamburger at that breakpoint', () => {
  const script = read('script.js');
  assert.ok(script.includes(`".${TOGGLE_CLASS}"`) && script.includes(`"#${MOBILE_NAV_ID}"`), `script.js no longer binds .${TOGGLE_CLASS} / #${MOBILE_NAV_ID}; update this test`);
  let hiding = 0;
  const stillBroken = new Set();
  for (const page of PAGES) {
    const raw = read(page);
    const html = markup(raw);
    const sheets = tags(html, 'link')
      .filter((l) => /\bstylesheet\b/.test(l.rel ?? '') || /\.css(\?|$)/.test(l.href ?? ''))
      .map((l) => localFile(l.href, page))
      .filter((f) => existsSync(path.join(ROOT, f)));
    const css = [...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).concat([...new Set(sheets)].map(read)).join('\n');
    const rules = mediaRules(css);
    const hides = rules.filter((r) => r.display === 'none' && r.selectors.some((s) => /(^|[\s>+~])\.[\w-]*nav[\w-]*links$/.test(s)));
    if (hides.length === 0) continue;
    hiding++;

    const gaps = [];
    const button = tags(html, 'button').find((b) => (b.class ?? '').split(/\s+/).includes(TOGGLE_CLASS));
    if (!button) gaps.push(`no <button class="${TOGGLE_CLASS}">`);
    else if (button['aria-controls'] !== MOBILE_NAV_ID) gaps.push(`hamburger aria-controls="${button['aria-controls']}", expected "${MOBILE_NAV_ID}"`);
    const panel = html.match(new RegExp(`<([\\w-]+)\\b[^>]*\\sid=["']${MOBILE_NAV_ID}["'][^>]*>([\\s\\S]*?)</\\1>`, 'i'));
    if (!panel) gaps.push(`no #${MOBILE_NAV_ID} panel`);
    else if (!/<a\b[^>]*\shref=/i.test(panel[2])) gaps.push(`#${MOBILE_NAV_ID} has no links`);
    if (!tags(html, 'script').some((s) => /(^|\/)script\.js(\?|$)/.test(s.src ?? ''))) gaps.push('script.js (the hamburger handler) is not loaded');
    for (const { query } of hides) {
      const shown = rules.some((r) => r.query === query && r.display && r.display !== 'none' && r.selectors.some((s) => s.endsWith(`.${TOGGLE_CLASS}`)));
      if (!shown) gaps.push(`@media${query} hides the nav links but never shows .${TOGGLE_CLASS}`);
    }

    if (KNOWN_NAV_GAPS.has(page)) { if (gaps.length) stillBroken.add(page); }
    else assert.deepEqual(gaps, [], `${page}: nav links hidden at a breakpoint without a working hamburger`);
  }
  assert.ok(hiding >= 20, `only ${hiding} pages hide their nav links; the CSS scan is broken`);
  assert.deepEqual([...KNOWN_NAV_GAPS].filter((p) => !stillBroken.has(p)), [], 'fixed pages still listed in KNOWN_NAV_GAPS; remove them');
});
