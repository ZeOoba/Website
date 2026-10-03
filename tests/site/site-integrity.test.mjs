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
const { jsonLdBlocks, stripHtmlComments } = createRequire(import.meta.url)('../../scripts/validate-jsonld.js');

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

// A commented-out <url> is not in the sitemap, so parse without comments.
const SITEMAP_XML = read('sitemap.xml').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
const SITEMAP_FILES = [...SITEMAP_XML.matchAll(/<loc>https:\/\/oxfordra\.net(\/[^<]*)<\/loc>/g)].map(({ 1: p }) =>
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

// Markup with comments and raw-text element contents blanked out (same length,
// so indexes still map to line numbers). Their contents are not DOM structure.
// One left-to-right pass, as the tokenizer reads it: a "<!--" inside a script
// is script text, and a <script> inside a comment is comment text.
function markup(html) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return html.replace(
    /(<(script|style|template|textarea)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)|<!--(?:>|->|[\s\S]*?(?:-->|$))/gi,
    (m, open, _n, body, close) => (open ? open + blank(body) + close : blank(m))
  );
}
const lineOf = (html, index) => html.slice(0, index).split('\n').length;

// Our own origin, in any spelling a link might use (Netlify redirects http and
// www to https://oxfordra.net).
const SAME_SITE = /^(?:https?:)?\/\/(?:www\.)?oxfordra\.net(?=[/?#]|$)/i;
const isExternal = (url) => (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) && !SAME_SITE.test(url);

// Repo-relative path of a same-site URL. A bare host (`https://oxfordra.net`)
// is the site root, not a path relative to the linking page.
const localFile = (url, page) => {
  const absolute = SAME_SITE.test(url);
  let clean = url.replace(SAME_SITE, '').split(/[?#]/)[0];
  try { clean = decodeURIComponent(clean); } catch { /* malformed escape: keep as written, existence check will fail */ }
  if (absolute && clean === '') return '';
  return clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(page), clean);
};

function jsonLd(html) {
  return [...stripHtmlComments(html).matchAll(jsonLdBlocks())].map((m) => JSON.parse(m[1]));
}
function* walkJson(node) {
  if (Array.isArray(node)) for (const n of node) yield* walkJson(n);
  else if (node && typeof node === 'object') {
    yield node;
    for (const v of Object.values(node)) yield* walkJson(v);
  }
}

// ── Structured data ──────────────────────────────────────────────────────────

test('every ItemList and BreadcrumbList has sequential positions and a numberOfItems (when declared) equal to its element count', () => {
  let lists = 0, crumbs = 0;
  for (const page of PAGES) {
    for (const node of walkJson(jsonLd(read(page)))) {
      if (node['@type'] !== 'ItemList' && node['@type'] !== 'BreadcrumbList') continue;
      if (node['@type'] === 'ItemList') lists++; else crumbs++;
      // An empty list is a legitimate state (available-space when every suite is
      // leased; build-listings.mjs accepts []), so only consistency is enforced.
      const items = node.itemListElement ?? [];
      assert.ok(Array.isArray(items), `${page}: ItemList "${node.name}" itemListElement is not an array`);
      if ('numberOfItems' in node) {
        assert.equal(node.numberOfItems, items.length, `${page}: ItemList "${node.name}" numberOfItems ${node.numberOfItems} ≠ ${items.length} elements`);
      }
      assert.deepEqual(items.map((i) => i.position), items.map((_, n) => n + 1), `${page}: ItemList "${node.name}" positions are not 1..${items.length}`);
    }
  }
  assert.ok(lists >= 4, `expected at least the 4 known ItemLists, found ${lists}`);
  assert.ok(crumbs >= 15, `expected a BreadcrumbList on every inner page, found ${crumbs}`);
});

// Every indexable page's structured-data types, pinned. verify-jsonld.mjs only
// requires SOME block on six pages, so emptying markets/ or tenant-resources,
// or dropping a FAQPage anywhere, passed. A page added to the sitemap must be
// added here too.
const EXPECTED_JSONLD_TYPES = {
  'index.html': ['FAQPage', 'Organization', 'WebSite'],
  'about.html': ['BreadcrumbList', 'FAQPage', 'Organization'],
  'portfolio.html': ['BreadcrumbList', 'FAQPage', 'ItemList'],
  'properties/9050-red-branch-road.html': ['BreadcrumbList', 'Place'],
  'properties/29000-information-lane.html': ['BreadcrumbList', 'Place'],
  'properties/1900-north-broadway.html': ['BreadcrumbList', 'Place'],
  'properties/3540-e-fifth-avenue.html': ['BreadcrumbList', 'Place'],
  'properties/55-new-plant-court.html': ['BreadcrumbList', 'Place'],
  'properties/2000-2002-zettler-rd.html': ['BreadcrumbList', 'Place'],
  'properties/2004-2008-zettler-rd.html': ['BreadcrumbList', 'Place'],
  'properties/2012-2026-zettler-rd.html': ['BreadcrumbList', 'Place'],
  'properties/2800-2826-banwick-rd.html': ['BreadcrumbList', 'Place'],
  'properties/384-398-morrison-rd.html': ['BreadcrumbList', 'Place'],
  'properties/406-420-morrison-rd.html': ['BreadcrumbList', 'Place'],
  'properties/4601-e-fifth-avenue.html': ['BreadcrumbList', 'Place'],
  'properties/4595-e-fifth-avenue.html': ['BreadcrumbList', 'Place'],
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
  const urls = [...SITEMAP_XML.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
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
      // Browsers scroll to an element's id, or to <a name>; a form's or input's
      // name is not a fragment target.
      const html = markup(read(page));
      const ids = [...html.matchAll(/<[\w-]+\b[^>]*?\sid\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);
      const anchors = [...html.matchAll(/<a\b[^>]*?\sname\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);
      idCache.set(page, new Set([...ids, ...anchors]));
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
      if (isExternal(base)) continue; // external site
      let target = page;
      if (base) {
        const f = localFile(base, page);
        // Clean URLs have no extension; anything else (flyer.pdf#page=2) is served as-is.
        target = f === '' || f.endsWith('/') ? `${f}index.html` : path.posix.extname(f) ? f : `${f}.html`;
      }
      checked++;
      if (!existsSync(path.join(ROOT, target))) broken.push(`${page}:${lineOf(html, a._index)} ${href} → ${target} does not exist`);
      else if (!target.endsWith('.html')) continue; // a PDF's #page= is not an element id
      else if (!idsOf(target).has(fragment)) broken.push(`${page}:${lineOf(html, a._index)} ${href} → no id="${fragment}" in ${target}`);
    }
  }
  assert.ok(checked > 0, 'found no fragment links at all; the scan is broken');
  assert.deepEqual(broken, [], 'fragment links with no target');
});

test('og:image exists and its declared og:image:width/height match the real file', () => {
  for (const page of PAGES) {
    const metas = tags(markup(read(page)), 'meta');
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
          if (isExternal(url)) continue;
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

test('every same-site <img src>, <source src> and image preload href exists', () => {
  const missing = [];
  let checked = 0;
  for (const page of PAGES) {
    const html = markup(read(page));
    const refs = [
      ...tags(html, 'img').map((t) => [t, t.src]),
      ...tags(html, 'source').map((t) => [t, t.src]),
      ...tags(html, 'link').filter((t) => /\bpreload\b/.test(t.rel ?? '') && t.as === 'image').map((t) => [t, t.href]),
    ];
    for (const [tag, url] of refs) {
      if (!url || /^data:/i.test(url) || isExternal(url)) continue;
      checked++;
      const file = localFile(url, page);
      if (!existsSync(path.join(ROOT, file))) missing.push(`${page}:${lineOf(html, tag._index)} ${url}`);
    }
  }
  assert.ok(checked > 0, 'found no image references at all; the scan is broken');
  assert.deepEqual(missing, [], 'image references to files that do not exist');
});

// A link that resolves only through _redirects (or not at all) is stale: the
// visitor lands somewhere other than where the link says. Checked against the
// built dist/, so a file that exists in the repo but is not published (not in
// build-dist.mjs's allowlist) also fails.
// _redirects rules that SERVE content (status 200 rewrites/proxies), e.g. an
// /api/* path answered by a function. A link to one of those is not stale.
const REWRITES = read('_redirects').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split(/\s+/)).filter(([, , status]) => /^200!?$/.test(status ?? ''))
  .map(([from]) => new RegExp('^' + from.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[\w]+/g, '[^/]+') + '$'));

test('every same-site link lands on a file that ships in dist/', () => {
  const dist = path.join(ROOT, 'dist');
  assert.ok(existsSync(dist), 'dist/ missing — run `npm run build` first');
  const broken = [];
  let checked = 0;
  for (const page of PAGES) {
    const html = markup(read(page));
    for (const a of tags(html, 'a')) {
      const href = (a.href ?? '').trim();
      if (!href || href.startsWith('#') || href.startsWith('?')) continue; // same page: see the #fragment test
      if (isExternal(href)) continue; // mailto:, tel:, other sites
      const urlPath = '/' + localFile(href, page);
      if (urlPath.startsWith('/.netlify/') || REWRITES.some((re) => re.test(urlPath))) continue; // served by Netlify, not a file
      checked++;
      const target = pageTarget(href, page);
      if (!existsSync(path.join(dist, target))) broken.push(`${page}:${lineOf(html, a._index)} ${href} → dist/${target} does not exist`);
    }
  }
  assert.ok(checked > 100, `only ${checked} same-site links found; the scan is broken`);
  assert.deepEqual(broken, [], 'links to files that do not ship');
});

// Cache-busters drift silently: a page left on an old ?v= keeps serving
// returning visitors a stale cached copy. Keyed on the exact resolved file, so
// /application-script.js and /script.js are separate assets.
test('each versioned asset is requested with one ?v= across every page', () => {
  const versions = new Map();
  for (const page of PAGES) {
    const html = markup(read(page));
    for (const t of [...tags(html, 'script'), ...tags(html, 'link')]) {
      const url = t.src ?? t.href;
      const v = url?.match(/[?&]v=([^&#]+)/)?.[1];
      if (!v || isExternal(url)) continue;
      const file = localFile(url, page);
      if (!versions.has(file)) versions.set(file, new Map());
      const byV = versions.get(file);
      byV.set(v, [...(byV.get(v) ?? []), page]);
    }
  }
  assert.ok(versions.has('script.js') && versions.has('styles.css'), 'found no versioned script.js/styles.css; the scan is broken');
  const drift = [...versions].filter(([, byV]) => byV.size > 1).map(([file, byV]) =>
    `${file}: ${[...byV].map(([v, pages]) => `v=${v} on ${[...new Set(pages)].join(', ')}`).join(' | ')}`);
  assert.deepEqual(drift, [], 'assets requested with more than one cache-buster version');
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
  let seen = 0;
  for (const page of PAGES) {
    const html = markup(read(page));
    const stack = [];
    for (const m of html.matchAll(re)) {
      seen++;
      const [, closing, raw] = m;
      const tag = raw.toLowerCase();
      if (!closing) { stack.push({ tag, line: lineOf(html, m.index) }); continue; }
      const open = stack.pop();
      assert.ok(open, `${page}:${lineOf(html, m.index)} </${tag}> closes nothing`);
      assert.equal(open.tag, tag, `${page}:${lineOf(html, m.index)} </${tag}> closes <${open.tag}> opened on line ${open.line}`);
    }
    assert.deepEqual(stack.map((s) => `<${s.tag}> line ${s.line}`), [], `${page} leaves containers unclosed`);
  }
  assert.ok(seen > 0, 'found no block containers at all; the scan is broken');
});

// ── Mobile navigation ───────────────────────────────────────────────────────

// A width-only reading of a media query: a list of { min, max } ranges in px
// (any one may match), or [] when it can never apply on screen (print). Other
// features (orientation, hover, prefers-*) are ignored.
// Both syntaxes: `(max-width:960px)` and Media Queries 4 ranges such as
// `(width<=767px)` or `(600px<=width<1280px)` (styles.css uses the latter).
function mediaRanges(query) {
  const px = (n, unit) => Number(n) * (unit === 'px' ? 1 : 16);
  const EPS = 0.01; // strict `<` / `>` excludes the boundary pixel
  return query.toLowerCase().split(',').flatMap((part) => {
    // `not print` is every screen; any other `not` query is left out.
    if (/^\s*not\b/.test(part)) return /^\s*not\s+print\s*$/.test(part) ? [{ min: 0, max: Infinity }] : [];
    if (/\bprint\b/.test(part) && !/\b(screen|all)\b/.test(part)) return [];
    let min = 0, max = Infinity;
    const lower = (v) => { min = Math.max(min, v); };
    const upper = (v) => { max = Math.min(max, v); };
    for (const [, n, u] of part.matchAll(/max-width\s*:\s*([\d.]+)(px|em|rem)/g)) upper(px(n, u));
    for (const [, n, u] of part.matchAll(/min-width\s*:\s*([\d.]+)(px|em|rem)/g)) lower(px(n, u));
    for (const [, op, n, u] of part.matchAll(/\bwidth\s*(<=|<|>=|>)\s*([\d.]+)(px|em|rem)/g)) {
      const v = px(n, u);
      if (op === '<=') upper(v); else if (op === '<') upper(v - EPS); else if (op === '>=') lower(v); else lower(v + EPS);
    }
    for (const [, n, u, op] of part.matchAll(/([\d.]+)(px|em|rem)\s*(<=|<|>=|>)\s*width\b/g)) {
      const v = px(n, u);
      if (op === '<=') lower(v); else if (op === '<') lower(v + EPS); else if (op === '>=') upper(v); else upper(v - EPS);
    }
    return min <= max ? [{ min, max }] : [];
  });
}

// Specificity as [ids, classes/attributes/pseudo-classes, elements].
function specificity(selector) {
  const s = selector.replace(/::?(?:before|after|placeholder|marker|selection)\b/g, '').replace(/:where\([^)]*\)/g, ''); // :where() adds nothing
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!not\(|is\(|where\()[\w-]+/g) ?? []).length;
  const elements = (s.replace(/\[[^\]]*\]|\([^)]*\)/g, '').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, elements];
}

// Intersection of two range lists (null = unconditional).
function intersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.flatMap((x) => b.map((y) => ({ min: Math.max(x.min, y.min), max: Math.min(x.max, y.max) }))).filter((r) => r.min <= r.max);
}

// Style rules in source order, one entry per selector: { ranges, selector,
// display, important, spec, order }. ranges is null for an unconditional rule.
// @media nests (ranges intersect); @supports and @layer are descended into as
// unconditional; other at-rule blocks (@font-face, @keyframes, …) are skipped.
function cssRules(css) {
  const out = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blockEnd = (open) => {
    let depth = 1, j = open + 1;
    while (depth && j < src.length) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0, j++;
    return j;
  };
  const push = (ranges, selectors, decls) => {
    const d = decls.match(/(?:^|;)\s*display\s*:\s*([\w-]+)\s*(!\s*important)?/i);
    for (const selector of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
      out.push({ ranges, selector, display: d?.[1], important: Boolean(d?.[2]), spec: specificity(selector), order: out.length });
    }
  };
  const walk = (from, to, ranges) => {
    let i = from;
    while (i < to) {
      const open = src.indexOf('{', i);
      if (open === -1 || open >= to) break;
      const prelude = src.slice(i, open).replace(/^[\s;}]+/, '').replace(/^(?:@(?:import|charset|namespace|layer)[^;{]*;\s*)+/g, '').trim();
      const end = blockEnd(open);
      if (prelude.startsWith('@media')) walk(open + 1, end - 1, intersect(ranges, mediaRanges(prelude.slice(6))));
      else if (/^@(supports|layer)\b/.test(prelude)) walk(open + 1, end - 1, ranges);
      else if (!prelude.startsWith('@')) push(ranges, prelude, src.slice(open + 1, end - 1));
      i = end;
    }
  };
  walk(0, src.length, null);
  return out;
}

// The computed `display` of the element whose last compound selector carries
// `cls`, at viewport width `w`: the winning applicable rule by !important, then
// specificity, then source order. State selectors (:hover, :focus, …) and
// pseudo-elements never describe the resting element, so they are skipped.
function displayAt(rules, cls, w) {
  const targets = (sel) => {
    // Last compound, with :not()/:is()/:where() arguments removed: those filter
    // the resting element rather than name a state, so `.x:not(.open)` counts.
    const last = sel.replace(/\([^)]*\)/g, (m) => m.replace(/[\s>+~]/g, '')).split(/[\s>+~]+/).pop();
    const named = new RegExp(`\\.${cls}(?![\\w-])|\\[class[~*]?=\\s*["']?${cls}["']?\\s*\\]`).test(last);
    const state = /:/.test(last.replace(/:(?:not|is|where)\([^)]*\)/g, ''));
    return named && !state;
  };
  const beats = (a, b) => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
    return false;
  };
  let win = null;
  for (const r of rules) {
    if (!r.display || !targets(r.selector)) continue;
    if (r.ranges && !r.ranges.some(({ min, max }) => w >= min && w <= max)) continue;
    const key = [Number(r.important), ...r.spec, r.order];
    if (!win || beats(key, win.key)) win = { key, display: r.display };
  }
  return win?.display ?? 'initial';
}

// Widths worth checking: common devices, plus both sides of every breakpoint.
function sampleWidths(rules) {
  const ws = new Set([320, 375, 414, 600, 768, 800, 1024, 1280, 1440]);
  for (const r of rules) for (const { min, max } of r.ranges ?? []) {
    if (min > 0) { ws.add(Math.ceil(min)); ws.add(Math.ceil(min) - 1); }
    if (Number.isFinite(max)) { ws.add(Math.floor(max)); ws.add(Math.floor(max) + 1); }
  }
  return [...ws].filter((w) => w >= 280 && w <= 2560).sort((a, b) => a - b);
}

// Range of the element whose opening tag starts at `start` (same-name nesting).
function elementEnd(html, start) {
  const name = html.slice(start + 1).match(/^[\w-]+/)[0];
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  for (let m; (m = re.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length;
}

// Repo file a same-site page link serves: clean URLs map to .html / index.html.
function pageTarget(href, page) {
  const f = localFile(href, page);
  return f === '' || f.endsWith('/') ? `${f}index.html` : path.posix.extname(f) ? f : `${f}.html`;
}

// The page's CSS in document order: inline <style> blocks and linked
// stylesheets, as the cascade sees them. <noscript> fallbacks are left out
// because a scripting browser never applies them.
function pageCss(raw, page) {
  const doc = stripHtmlComments(raw).replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  const seen = new Set();
  const parts = [];
  for (const m of doc.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>|<link\b[^>]*>/gi)) {
    if (m[2] !== undefined) {
      // <style media="…"> applies only where the query matches. (Linked sheets'
      // media="print" is the async-load trick; script flips it to "all".)
      const media = attrs(`<style${m[1]}>`).media;
      parts.push(media && media !== 'all' ? `@media ${media}{${m[2]}}` : m[2]);
      continue;
    }
    const l = attrs(m[0]);
    if (!/\bstylesheet\b/.test(l.rel ?? '') || !l.href) continue;
    const f = localFile(l.href, page);
    if (seen.has(f) || !existsSync(path.join(ROOT, f))) continue;
    seen.add(f);
    parts.push(read(f));
  }
  return parts.join('\n');
}

// script.js binds the hamburger by these two hooks; a page that hides its nav
// links must provide both, or small screens get no navigation at all.
const TOGGLE_CLASS = 'nav__mobile-btn';
const MOBILE_NAV_ID = 'mobileNav';

// A static reading of the cascade. It cannot see JavaScript or the real DOM;
// mobile-nav.test.mjs renders every page in a browser for that. This half runs
// everywhere, fast, and names the offending rule.
test('wherever a page hides its nav links, a wired hamburger is showing', () => {
  const script = read('script.js');
  assert.ok(script.includes(`".${TOGGLE_CLASS}"`) && script.includes(`"#${MOBILE_NAV_ID}"`), `script.js no longer binds .${TOGGLE_CLASS} / #${MOBILE_NAV_ID}; update this test`);
  let hiding = 0;
  for (const page of PAGES) {
    const raw = read(page);
    const html = markup(raw);
    const rules = cssRules(pageCss(raw, page));
    const hiddenAt = sampleWidths(rules).filter((w) => displayAt(rules, 'nav__links', w) === 'none');
    if (hiddenAt.length === 0) continue;
    hiding++;

    const gaps = [];
    const button = tags(html, 'button').find((b) => (b.class ?? '').split(/\s+/).includes(TOGGLE_CLASS));
    if (!button) gaps.push(`no <button class="${TOGGLE_CLASS}">`);
    else {
      if (button['aria-controls'] !== MOBILE_NAV_ID) gaps.push(`hamburger aria-controls="${button['aria-controls']}", expected "${MOBILE_NAV_ID}"`);
      // Inside .nav__links the button is hidden along with the links it replaces.
      for (const m of html.matchAll(/<([\w-]+)\b[^>]*\sclass\s*=\s*["'][^"']*\bnav__links\b[^"']*["'][^>]*>/gi)) {
        if (button._index > m.index && button._index < elementEnd(html, m.index)) gaps.push('the hamburger sits inside .nav__links, so it hides with them');
      }
    }
    const panelOpen = html.match(new RegExp(`<[\\w-]+\\b[^>]*\\sid\\s*=\\s*["']${MOBILE_NAV_ID}["'][^>]*>`, 'i'));
    if (!panelOpen) gaps.push(`no #${MOBILE_NAV_ID} panel`);
    else {
      const panel = html.slice(panelOpen.index, elementEnd(html, panelOpen.index));
      const links = tags(panel, 'a');
      if (links.length === 0) gaps.push(`#${MOBILE_NAV_ID} has no links`);
      for (const a of links) {
        const href = a.href ?? '';
        if (!href || href.startsWith('#')) gaps.push(`#${MOBILE_NAV_ID} link href="${href}" goes nowhere`);
        else if (!isExternal(href)) {
          if (!existsSync(path.join(ROOT, pageTarget(href, page)))) gaps.push(`#${MOBILE_NAV_ID} link ${href} → ${pageTarget(href, page)} does not exist`);
        }
      }
    }
    const loadsScript = tags(html, 'script').some((s) => s.src && localFile(s.src, page) === 'script.js');
    if (!loadsScript) gaps.push('script.js (the hamburger handler) is not loaded from /script.js');
    const buttonHiddenAt = hiddenAt.filter((w) => displayAt(rules, TOGGLE_CLASS, w) === 'none');
    if (buttonHiddenAt.length) gaps.push(`at ${buttonHiddenAt.join(', ')}px the nav links AND .${TOGGLE_CLASS} both compute to display:none`);

    assert.deepEqual(gaps, [], `${page}: nav links hidden without a working hamburger`);
  }
  assert.ok(hiding >= 20, `only ${hiding} pages hide their nav links; the CSS scan is broken`);
});

// scripts/build-kb.mjs rewrites netlify/edge-functions/knowledge-base.json on every
// build (new generatedAt, page text from the current tree). Tracking it made it show
// dirty in every worktree, and the committed copy went weeks stale because Netlify and
// `npm run verify` regenerate it before it is read. It must stay a build artifact.
test('knowledge-base.json is a gitignored build artifact, not a tracked file', async () => {
  const { execFileSync } = await import('node:child_process');
  const KB = 'netlify/edge-functions/knowledge-base.json';
  // The mutation harness runs these tests in a temp copy with no .git; only the
  // .gitignore assertion below can run there.
  if (existsSync(path.join(ROOT, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '--', KB], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(tracked, '', `${KB} must not be tracked (regenerated on every build)`);
  }
  assert.match(read('.gitignore'), /^\/?netlify\/edge-functions\/knowledge-base\.json\s*$/m, `${KB} must be in .gitignore`);
});
