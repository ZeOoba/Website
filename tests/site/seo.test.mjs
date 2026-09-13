// SEO regression guards from the 2026-09-13 oxfordra.net SEO audit.
//
// Each test pins one audit finding so it cannot quietly come back:
//   #1  /page.html duplicates served 200 alongside the clean URL
//   #2  Organization logo was white-on-transparent and 448x56 (< Google's 112x112)
//   #3  "30-day close" contradicted the "30–45 days" claim elsewhere
//   #5  Article JSON-LD on the owner guides had no datePublished/dateModified
//   #6  Owner guides were linked only from the global nav/footer
//   #8  /404 was a soft 404 carrying a canonical
//   #9  Short meta descriptions on indexable pages
//   #10 Title separator drift and a noindex page with no Open Graph tags
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// sitemap.xml is the list of pages we ask search engines to index.
const SITEMAP_PAGES = [...read('sitemap.xml').matchAll(/<loc>https:\/\/oxfordra\.net(\/[^<]*)<\/loc>/g)].map((m) => {
  const p = m[1];
  const file = p === '/' ? 'index.html' : p.endsWith('/') ? `${p.slice(1)}index.html` : `${p.slice(1)}.html`;
  return { path: p, file };
});

const GUIDES = [
  '/resources/selling-industrial-building-without-a-broker',
  '/resources/how-industrial-buildings-are-valued',
  '/resources/1031-exchange-industrial-property-guide',
  '/resources/industrial-building-sale-document-checklist',
];

function meta(html, attr, name) {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (new RegExp(`${attr}="${name}"`, 'i').test(tag)) return tag.match(/content="([^"]*)"/i)?.[1] ?? '';
  }
  return null;
}

// Decode the handful of entities used in our meta content so lengths are what
// a search engine displays.
const decode = (s) =>
  s.replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/&#39;/g, "'");

function redirectRules() {
  return read('_redirects')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));
}

test('#1 every sitemap page has a forced 301 from its .html file path to the clean URL, ahead of the catch-all', () => {
  const rules = redirectRules();
  const catchAll = rules.findIndex(([from]) => from === '/*');
  assert.ok(catchAll >= 0, 'expected the /* 404 catch-all rule');
  for (const { path: clean, file } of SITEMAP_PAGES) {
    const idx = rules.findIndex(([from, to, status]) => from === `/${file}` && to === clean && status === '301!');
    assert.ok(idx >= 0, `missing "/${file}  ${clean}  301!" in _redirects`);
    assert.ok(idx < catchAll, `/${file} redirect must come before the /* catch-all`);
  }
});

function pngSize(rel) {
  const buf = readFileSync(path.join(ROOT, rel));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${rel} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('#2 Organization logo is a non-white PNG of at least 112x112 on every page that declares it', () => {
  for (const page of ['index.html', 'about.html']) {
    const logos = [...read(page).matchAll(/"logo":\s*"https:\/\/oxfordra\.net\/([^"]+)"/g)].map((m) => m[1]);
    assert.ok(logos.length > 0, `${page} declares no Organization logo`);
    for (const logo of logos) {
      assert.doesNotMatch(logo, /white/i, `${page} logo ${logo} is the white variant (invisible on white SERPs)`);
      assert.ok(existsSync(path.join(ROOT, logo)), `${page} logo ${logo} does not exist`);
      const { width, height } = pngSize(logo);
      assert.ok(width >= 112 && height >= 112, `${logo} is ${width}x${height}, below Google's 112x112 minimum`);
    }
  }
});

test('#3 no page claims a flat 30-day close (canonical claim is 30–45 days)', () => {
  const files = [...new Set([...SITEMAP_PAGES.map((p) => p.file), '404.html', 'tenant-application.html', 'llms.txt'])];
  for (const file of files) {
    const hits = read(file).match(/\b30(?:-|\s)days?\b/gi);
    assert.equal(hits, null, `${file} still says ${JSON.stringify(hits)}`);
  }
});

test('#5 every owner-guide Article has ISO datePublished and dateModified', () => {
  for (const guide of GUIDES) {
    const html = read(`${guide.slice(1)}.html`);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const article = blocks.find((b) => b['@type'] === 'Article');
    assert.ok(article, `${guide} has no Article block`);
    for (const key of ['datePublished', 'dateModified']) {
      assert.match(article[key] ?? '', /^\d{4}-\d{2}-\d{2}$/, `${guide} Article.${key} missing or not YYYY-MM-DD`);
    }
    assert.ok(article.dateModified >= article.datePublished, `${guide} dateModified precedes datePublished`);
  }
});

test('#6 home, for-brokers and market pages link to at least two owner guides from page content', () => {
  for (const page of ['index.html', 'for-brokers.html', 'markets/index.html', 'markets/columbus-oh.html', 'markets/maryland.html']) {
    const main = read(page).match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? '';
    const linked = GUIDES.filter((g) => main.includes(`href="${g}"`));
    assert.ok(linked.length >= 2, `${page} <main> links to ${linked.length} guide(s); expected >= 2`);
  }
});

test('#8 404 page carries no canonical and /404 is served with a real 404 status', () => {
  assert.ok(!/rel="canonical"/i.test(read('404.html')), '404.html must not declare a canonical');
  const rules = redirectRules();
  const catchAll = rules.findIndex(([from]) => from === '/*');
  const idx = rules.findIndex(([from, to, status]) => from === '/404' && to === '/404.html' && status === '404!');
  assert.ok(idx >= 0 && idx < catchAll, 'expected "/404  /404.html  404!" before the catch-all');
});

test('#9 indexable pages have a 140–160 character meta description', () => {
  for (const { file } of SITEMAP_PAGES) {
    const desc = meta(read(file), 'name', 'description');
    assert.ok(desc !== null, `${file} has no meta description`);
    const len = [...decode(desc)].length;
    assert.ok(len >= 140 && len <= 160, `${file} meta description is ${len} chars: "${decode(desc)}"`);
  }
});

test('#10 titles use the "Page | Oxford Realty Advisors" pattern and application-received has Open Graph tags', () => {
  for (const file of ['privacy.html', 'terms.html']) {
    const title = read(file).match(/<title>([^<]*)<\/title>/)?.[1];
    assert.match(title ?? '', / \| Oxford Realty Advisors$/, `${file} title separator: "${title}"`);
  }
  const html = read('application-received.html');
  for (const prop of ['og:title', 'og:description', 'og:image', 'og:type']) {
    assert.ok(meta(html, 'property', prop), `application-received.html missing ${prop}`);
  }
});
