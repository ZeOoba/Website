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
// Follow-ups from the PR #77 site-qc-reviewer pass (tagged QC-n):
//   QC-1 gold (#C9A96E) stat text on parchment/white (~2.1:1 contrast)
//   QC-2 sitemap <lastmod> older than the page's Article dateModified
//   QC-3 Article publisher.logo still the 180px app icon
//   QC-4 inline :root that omits --gold-accessible while the page uses it
//   QC-5 guide-card CSS copy-pasted into five pages; mixed styles.css versions
//   QC-6 *.test.js files published into dist/
//   QC-7 /tenant-application.html and /application-received.html duplicate 200s
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { imageSize } from './lib/image-size.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// sitemap.xml is the list of pages we ask search engines to index. A
// commented-out <url> is not in it, so parse without comments.
const SITEMAP_XML = read('sitemap.xml').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
const SITEMAP_PAGES = [...SITEMAP_XML.matchAll(/<loc>https:\/\/oxfordra\.net(\/[^<]*)<\/loc>/g)].map((m) => {
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
  // QC-7: noindex pages that are still publicly linked get the same treatment.
  const pages = [...SITEMAP_PAGES, { path: '/tenant-application', file: 'tenant-application.html' }, { path: '/application-received', file: 'application-received.html' }];
  for (const { path: clean, file } of pages) {
    const idx = rules.findIndex(([from, to, status]) => from === `/${file}` && to === clean && status === '301!');
    assert.ok(idx >= 0, `missing "/${file}  ${clean}  301!" in _redirects`);
    assert.ok(idx < catchAll, `/${file} redirect must come before the /* catch-all`);
  }
});

function pngSize(rel) {
  const { type, width, height } = imageSize(path.join(ROOT, rel));
  assert.equal(type, 'png', `${rel} is not a PNG`);
  return { width, height };
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

// ── PR #77 QC follow-ups ────────────────────────────────────────────────────

function htmlFiles(dir = ROOT, rel = '') {
  const skip = new Set(['dist', 'node_modules', '.netlify', '.git', 'tests', 'evals', 'scripts', 'netlify', 'docs', '.claude']);
  const out = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!skip.has(e.name)) out.push(...htmlFiles(dir, r)); }
    else if (e.name.endsWith('.html')) out.push(r);
  }
  return out;
}

test('QC-1 stat text on light cards uses --gold-accessible, not raw --gold', () => {
  // Raw gold is only legible on navy/photo grounds; on these pages that is the hero motto alone.
  for (const file of ['for-brokers.html', 'sell-your-building.html']) {
    const offenders = read(file)
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /style="[^"]*color:var\(--gold\)/.test(line) && !line.includes('hero-motto'));
    assert.deepEqual(offenders.map((o) => `${file}:${o.n}`), [], 'inline color:var(--gold) on a light ground');
  }
});

test('QC-2 sitemap lastmod is never older than a guide\'s Article dateModified', () => {
  const sitemap = SITEMAP_XML;
  for (const guide of GUIDES) {
    const lastmod = sitemap.match(new RegExp(String.raw`<loc>https://oxfordra\.net${guide}</loc><lastmod>([\d-]+)</lastmod>`))?.[1];
    const article = read(`${guide.slice(1)}.html`).match(/"dateModified":\s*"([\d-]+)"/)?.[1];
    assert.ok(lastmod && article, `${guide}: lastmod=${lastmod} dateModified=${article}`);
    assert.ok(lastmod >= article, `${guide}: sitemap lastmod ${lastmod} predates Article dateModified ${article}`);
  }
});

test('QC-3 every Article publisher logo is the 512px Organization logo', () => {
  for (const guide of GUIDES) {
    const html = read(`${guide.slice(1)}.html`);
    assert.ok(!html.includes('"url": "https://oxfordra.net/apple-touch-icon.png"'), `${guide} publisher.logo still apple-touch-icon`);
    assert.match(html, /"url": "https:\/\/oxfordra\.net\/images\/oxford-logo-512\.png"/, `${guide} publisher.logo`);
  }
});

test('QC-4 a page that redeclares :root inline and uses --gold-accessible also defines it', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    if (!html.includes('var(--gold-accessible)')) continue;
    for (const [root] of html.matchAll(/:root\{[^}]*\}/g)) {
      if (!root.includes('--navy')) continue; // only full token redeclarations
      assert.ok(root.includes('--gold-accessible'), `${file} inline :root omits --gold-accessible`);
    }
  }
});

test('QC-5 guide-card CSS lives once in styles.css and every page requests the same styles.css version', () => {
  assert.match(read('styles.css'), /\.guide-links\{/, 'styles.css must define .guide-links');
  const versions = new Set();
  for (const file of htmlFiles()) {
    const html = read(file);
    assert.ok(!/\.guide-links\{/.test(html), `${file} still inlines .guide-links CSS`);
    for (const [, v] of html.matchAll(/styles\.css\?v=(\d+)/g)) versions.add(v);
  }
  assert.equal(versions.size, 1, `mixed styles.css versions: ${[...versions].join(', ')}`);
});

test('QC-6 no *.test.* file is published into dist/', () => {
  const dist = path.join(ROOT, 'dist');
  assert.ok(existsSync(dist), 'dist/ missing — run `npm run build` first');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const leaked = walk(dist).filter((f) => /\.test\.[cm]?js$/.test(f)).map((f) => path.relative(dist, f));
  assert.deepEqual(leaked, [], 'test files leaked into dist/');
});

test('QC-8 the inline .btn--outline base rule uses --gold-accessible, with raw --gold only on dark grounds', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    for (const [rule] of html.matchAll(/(?:^|[}\n])\.btn--outline\{[^}]*\}/g)) {
      assert.ok(!/[{;]color:var\(--gold\)/.test(rule), `${file}: base .btn--outline text is raw --gold (~2.2:1 on white/parchment): ${rule.trim()}`);
    }
  }
  // Home hero and Featured Results sit on navy/photo grounds and keep full gold.
  assert.match(read('index.html'), /\.hero \.btn--outline[^{]*\{color:var\(--gold\)\}/, 'index.html needs a dark-ground override for hero outline buttons');
  assert.match(read('index.html'), /\.section--navy \.btn--outline[^{]*\{color:var\(--gold\)\}/, 'index.html needs a dark-ground override for navy-section outline buttons');
});

test('QC-9 dark-ground .btn--outline gold overrides never beat :hover (gold text on a gold hover fill)', () => {
  // `.section--navy .btn--outline{color:gold}` has the same specificity as
  // `.btn--outline:hover` and sits later, so the hover label vanished. Scope every
  // such override with :not(:hover).
  for (const file of htmlFiles()) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors] of css.matchAll(/([^{}]*\.btn--outline[^{}]*)\{color:var\(--gold\)\}/g)) {
      for (const sel of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
        assert.ok(/:not\(:hover\)$/.test(sel), `${file}: "${sel}" sets gold text without :not(:hover)`);
      }
    }
  }
});

// ── 2026-09-25 website-perfection audit (tagged WP-n) ───────────────────────
// Each pins one finding from the full-site audit so it cannot come back.

test('WP-1 no page names a market the firm does not own in (Indianapolis left in the broker form after PR #56)', () => {
  for (const file of htmlFiles()) {
    assert.ok(!/Indianapolis/i.test(read(file)), `${file} still mentions Indianapolis`);
  }
  for (const file of ['llms.txt', 'scripts/meta.md', 'manifest.json']) {
    assert.ok(!/Indianapolis/i.test(read(file)), `${file} still mentions Indianapolis`);
  }
});

test('WP-2 the placeholder LinkedIn Insight Tag is gone from every page and its two origins are out of the CSP', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    assert.ok(!/_linkedin_partner_id|snap\.licdn\.com/.test(html), `${file} still loads the LinkedIn Insight Tag (partner id was the placeholder XXXXXXX)`);
  }
  const headers = read('_headers');
  assert.ok(!/licdn\.com|linkedin\.com/.test(headers), '_headers still allows a LinkedIn origin nothing on the site uses');
});

test('WP-3 CSP carries the injection-hardening directives and the deprecated XSS auditor is off', () => {
  const headers = read('_headers');
  const csp = headers.match(/Content-Security-Policy:\s*([^\r\n]*)/)?.[1] ?? '';
  for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `CSP is missing "${directive}"`);
  }
  assert.ok(!/'unsafe-eval'/.test(csp), "CSP must never carry 'unsafe-eval'");
  assert.match(headers, /X-XSS-Protection:\s*0\b/, 'X-XSS-Protection must be 0 (the legacy auditor introduced side-channel leaks; CSP is the control)');
  // /index.html is force-301'd to / by _redirects, so a header block for it can never apply.
  assert.ok(!/^\/index\.html\s*$/m.test(headers), '_headers has an unreachable /index.html block (the path is 301!-redirected to /)');
});

test('WP-4 the nav logo has no "|" glyph in its SVG text (Lighthouse label-content-name-mismatch against the aria-label)', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    for (const [logo] of html.matchAll(/<a[^>]*class="nav__logo"[\s\S]*?<\/a>/g)) {
      const texts = [...logo.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].trim());
      assert.ok(!texts.includes('|'), `${file}: nav logo renders a "|" <text> node that breaks the accessible-name match`);
    }
  }
});

test('WP-5 the mobile navigation panel is a <nav> landmark (aria-label on a generic <div> is ignored by AT)', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    const opener = html.match(/<(\w+)[^>]*\bid="mobileNav"[^>]*>/);
    if (!opener) continue;
    assert.equal(opener[1].toLowerCase(), 'nav', `${file}: #mobileNav is a <${opener[1]}>, not <nav>`);
    assert.match(opener[0], /aria-label="/, `${file}: #mobileNav <nav> needs an aria-label to distinguish it from the primary nav`);
  }
});

test('WP-6 every track-record expander names the panel it controls with aria-controls, and the id exists', () => {
  const html = read('track-record.html');
  const summaries = [...html.matchAll(/<div class="track-card__summary"[^>]*>/g)].map((m) => m[0]);
  assert.ok(summaries.length >= 5, 'expected the five track-card expanders');
  for (const tag of summaries) {
    const id = tag.match(/aria-controls="([^"]+)"/)?.[1];
    assert.ok(id, `expander lacks aria-controls: ${tag}`);
    assert.ok(new RegExp(`<div class="track-card__details"[^>]*\\bid="${id}"`).test(html), `aria-controls="${id}" points at no .track-card__details`);
  }
});

test('WP-7 the range slider keeps a visible :focus-visible ring (its outline:0 beat the global rule)', () => {
  const css = read('styles.css');
  assert.match(css, /\.basis-engine__slider:focus-visible\{[^}]*outline:2px solid var\(--gold\)/, 'styles.css needs a .basis-engine__slider:focus-visible rule');
});

test('WP-8 every page can reveal its skip link before styles.css arrives', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    if (!/class="skip-link"/.test(html)) continue;
    const head = html.slice(0, html.indexOf('<body') > 0 ? html.indexOf('<body') : html.length);
    assert.match(head, /\.skip-link:focus\{top:0/, `${file}: no inline .skip-link:focus rule in <head>; the link stays hidden until the async stylesheet loads`);
  }
});

test('WP-9 titles stay ≤ 60 characters and end with "| Oxford Realty Advisors" (home may lead with the brand)', () => {
  for (const { file } of SITEMAP_PAGES) {
    const title = decode(read(file).match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
    assert.ok(title.length <= 60, `${file} title is ${title.length} chars: "${title}"`);
    if (file === 'index.html') assert.match(title, /^Oxford Realty Advisors \| /, `${file} title: "${title}"`);
    else assert.match(title, / \| Oxford Realty Advisors$/, `${file} title: "${title}"`);
    const og = decode(meta(read(file), 'property', 'og:title') ?? '');
    assert.equal(og, title, `${file}: og:title differs from <title>`);
  }
});

test('WP-10 llms.txt names the markets and the tenant count the pages claim', () => {
  const llms = read('llms.txt');
  for (const claim of ['Maryland', 'Columbus', 'Kansas City', '138+ tenants', '513,000+ SF', '30-45 days']) {
    assert.ok(llms.includes(claim), `llms.txt is missing "${claim}"`);
  }
});

test('WP-11 the chat facts file agrees with the pages on the founding claim (2005 everywhere; Gabriel 2026-09-25)', () => {
  const md = read('scripts/meta.md');
  assert.match(md, /Founded 2005/, 'meta.md must state Founded 2005');
  assert.ok(!/2008/.test(md), 'meta.md still carries the 2008 direct-ownership distinction the pages do not make');
});

test('WP-12 every file in images/ is referenced by something that ships', () => {
  const refs = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      // tests/ is excluded: a test or mutation case naming a file must not count as a reference.
      if (e.isDirectory()) { if (!['dist', 'node_modules', '.netlify', '.git', 'images', 'fonts', 'docs', '.claude', 'evals', 'tests'].includes(e.name)) walk(r); }
      else if (/\.(html|css|js|mjs|json|md|txt|xml)$/.test(e.name) && e.name !== 'README.md') refs.push(read(r));
    }
  };
  walk('');
  const corpus = refs.join('\n');
  const unused = readdirSync(path.join(ROOT, 'images')).filter((name) => !corpus.includes(name));
  assert.deepEqual(unused, [], `images/ files nothing references: ${unused.join(', ')}`);
});

test('WP-13 the tenant-application form loads script.js and application-script.js in an order the generic validator respects', () => {
  // application-script.js (parse-time submit listener) vetoes first; script.js's
  // deferred DOMContentLoaded validator must bail on a prevented event instead of
  // disabling the submit button and relabelling it "Sending…" on a form that
  // never left the page. Behaviour is pinned in form-validator.test.mjs; this
  // pins the source-level guard so a re-minify cannot drop it.
  const js = read('script.js');
  assert.match(js, /addEventListener\(\s*"submit"\s*,\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\.defaultPrevented\s*\)\s*\{?\s*return/, 'script.js submit handler must return early on a defaultPrevented event');
});

test('WP-17 CSP connect-src allows the exact Netlify RUM collector host, and only there, with no wildcard', () => {
  // Netlify injects /.netlify/scripts/rum at deploy time (the local dist/ build
  // never carries it, so csp-smoke cannot see it). That script POSTs Core Web
  // Vitals with a CORS fetch to the collector below. Without the allowance the
  // browser blocks the beacon on every page load ("connect-src" violation) and
  // RUM data is silently lost. Confirmed live 2026-09-28 via securitypolicyviolation.
  const RUM_HOST = 'https://ingesteer.services-prod.nsvcs.net';
  const csp = read('_headers').match(/Content-Security-Policy:\s*([^\r\n]*)/)?.[1] ?? '';
  const tokenised = csp.split(';').map((d) => d.trim().split(/\s+/)).filter((t) => t[0]);
  // Browsers honour the FIRST occurrence of a directive and ignore repeats, so a
  // second connect-src cannot be trusted to carry the host: require exactly one.
  assert.equal(tokenised.filter((t) => t[0] === 'connect-src').length, 1, 'CSP must contain exactly one connect-src directive');
  const directives = new Map(tokenised.map((t) => [t[0], t.slice(1)]));
  assert.ok((directives.get('connect-src') ?? []).includes(RUM_HOST), `connect-src must list ${RUM_HOST} (Netlify RUM beacon target)`);
  for (const [name, sources] of directives) {
    if (name !== 'connect-src') assert.ok(!sources.includes(RUM_HOST), `${RUM_HOST} is a fetch target only; it does not belong in ${name}`);
  }
  assert.ok(!/nsvcs\.net/.test(csp.replaceAll(RUM_HOST, '')), 'CSP must name the exact collector host, never a wildcard or a sibling *.nsvcs.net origin');
});

// ── 2026-09-28 data-accuracy & positioning pass (Phase 1 of the fix plan) ───
// Figures sourced from the Master Workbook DSOR (Notion 3706ecd8), most recent
// ingest 2026-09-06: 138 tenants, 513,158 SF roster (512,258 SF leasable), 14
// properties. Kansas City is downgraded from a co-equal "core market" to a
// portfolio-only holding sitewide (Gabriel, 2026-09-28) — it may still be
// mentioned as a place Oxford owns/leases, just never inside a "core markets"
// count or list.

test('WP-14 Kansas City is never listed among Oxford\'s "core markets" (Gabriel, 2026-09-28: KC is portfolio-only)', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    assert.ok(!/Three Core Markets/i.test(html), `${file} still claims "Three Core Markets"`);
    assert.ok(!/core markets are[^.]*Kansas City/i.test(html), `${file} lists Kansas City inside a "core markets are..." sentence`);
    assert.ok(!/core markets \([^)]*Kansas City[^)]*\)/i.test(html), `${file} lists Kansas City inside a "core markets (...)" parenthetical`);
  }
  for (const file of ['llms.txt', 'scripts/meta.md']) {
    const text = read(file);
    assert.ok(!/three core markets/i.test(text), `${file} still claims three core markets`);
  }
});

test('WP-15 firm stats reflect the 2026-09-06 Master Workbook ingest (513,000+ SF / 138+ tenants / 2 core markets)', () => {
  const idx = read('index.html');
  assert.ok(idx.includes('data-target="513000"'), 'index.html hero SF stat is not pinned to 513000');
  assert.ok(idx.includes('data-target="138"'), 'index.html hero tenant stat is not pinned to 138');
  assert.ok(idx.includes('data-target="2"'), 'index.html hero core-markets stat is not pinned to 2');
  for (const file of htmlFiles()) {
    const html = read(file);
    assert.ok(!/130\+\s*(<[^>]*>\s*)*Tenants/i.test(html), `${file} still claims 130+ tenants`);
    assert.ok(!/500,000\+/.test(html), `${file} still claims 500,000+ SF`);
  }
});

test('WP-16 the broker/owner deal-submission response promise is unified to 1 business day, not 48 hours', () => {
  for (const file of htmlFiles()) {
    assert.ok(!/within 48 hours/i.test(read(file)), `${file} still promises a response "within 48 hours"`);
  }
});

// ── 2026-09-28 copy & lead-gen pass (Phase 4a of the fix plan) ──────────────

test('WP-20 the leasing application and its confirmation page do not show the acquisitions rotator to a tenant', () => {
  for (const file of ['tenant-application.html', 'application-received.html']) {
    const html = read(file);
    assert.ok(!/What We(?:'|&rsquo;)re Buying Now|Actively seeking \$1M/i.test(html), `${file} still shows the acquisitions announcement bar to a prospective tenant`);
    assert.match(html, /class="announcement-bar__label">Now Leasing</, `${file}: announcement bar should read "Now Leasing"`);
  }
});

test('WP-21 the lease application labels rent and deposit as the applicant\'s proposal and states the response time up front', () => {
  const html = read('tenant-application.html');
  assert.match(html, /for="monthly-rent">Proposed Monthly Rent/);
  assert.match(html, /for="security-deposit">Proposed Security Deposit/);
  assert.match(html, /respond within 2 business days of submission/, 'response time must be stated before the applicant submits');
  assert.equal((html.match(/N\/A for any items that do not apply|please put N\/A/gi) || []).length, 1, 'the N/A instruction is stated once, not restated');
  assert.match(read('application-received.html'), /If we(?:'|&rsquo;)re unable to move forward, we(?:'|&rsquo;)ll email you either way/, 'confirmation page must cover the not-approved path');
});

test('WP-22 the four owner guides close with four different calls to action, and the 1031 guide carries a worked example', () => {
  const closers = new Map();
  for (const f of ['selling-industrial-building-without-a-broker', 'how-industrial-buildings-are-valued', '1031-exchange-industrial-property-guide', 'industrial-building-sale-document-checklist']) {
    const html = read(`resources/${f}.html`);
    const p = html.match(/<p style="[^"]*max-width:600px">(Oxford Realty Advisors buys[^<]*)<\/p>/)?.[1];
    assert.ok(p, `${f}: closing CTA paragraph not found`);
    closers.set(f, p);
  }
  assert.equal(new Set(closers.values()).size, closers.size, 'two guides share a verbatim closing CTA');
  const g = read('resources/1031-exchange-industrial-property-guide.html');
  assert.match(g, /<h3>A worked example<\/h3>/);
  for (const n of ['$2,000,000', '$700,000', '$1,300,000', '$1,500,000', '$2,300,000', '$1,000,000', '$200,000', '$1,100,000']) {
    assert.ok(g.includes(n), `1031 worked example is missing ${n}`);
  }
});

test('WP-23 contact.html names an acquisitions contact (Gabriel Goldberg, VP Acquisitions)', () => {
  const html = read('contact.html');
  assert.match(html, /Gabriel Goldberg, VP Acquisitions/);
  assert.match(html, /href="mailto:ggoldberg@oxfordra\.net"/);
});

// ── 2026-09-28 gated checklist lead magnet (Phase 4b of the fix plan) ───────
// The sale-ready checklist PDF sits behind a name+email form on the checklist
// guide. It is a SOFT gate by design: the form's success state reveals the link;
// nothing else links the file, and robots.txt asks crawlers to stay out.

const CHECKLIST_PDF = 'Oxford-Sale-Ready-Checklist.pdf';
const CHECKLIST_GUIDE = 'resources/industrial-building-sale-document-checklist.html';

test('WP-24 the checklist PDF is a real two-page PDF that ships, and crawlers are asked to stay out', () => {
  const bytes = readFileSync(path.join(ROOT, CHECKLIST_PDF));
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'not a PDF');
  assert.ok(bytes.length > 20_000, `suspiciously small (${bytes.length} bytes): the render probably failed`);
  assert.ok(read('scripts/build-dist.mjs').includes(`'${CHECKLIST_PDF}'`), 'build-dist.mjs does not publish the checklist PDF');
  assert.match(read('robots.txt'), new RegExp(`^Disallow: /${CHECKLIST_PDF.replace(/\./g, '\\.')}$`, 'm'), 'robots.txt must disallow the gated file');
  assert.ok(!read('sitemap.xml').includes(CHECKLIST_PDF), 'the gated file must not be in the sitemap');
});

test('WP-25 only the checklist form\'s success state links the PDF (the gate is not bypassed by a stray link)', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    if (file === CHECKLIST_GUIDE || !html.includes(CHECKLIST_PDF)) continue;
    assert.fail(`${file} links the gated checklist PDF outside the email form`);
  }
  const guide = read(CHECKLIST_GUIDE);
  const success = guide.match(/<div class="form-success" id="checklistSuccess"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(success && success[0].includes('style="display:none;"'), 'the success block must be hidden until the form succeeds');
  assert.ok(success[1].includes(CHECKLIST_PDF), 'the success block must carry the download link');
  assert.equal(guide.split(CHECKLIST_PDF).length - 1, 1, 'the PDF must be linked exactly once, inside the success block');
});

test('WP-26 the checklist form is honeypot-guarded, points at the privacy policy, and fires checklist_requested after the success state shows', () => {
  const guide = read(CHECKLIST_GUIDE);
  const form = guide.match(/<form\b[^>]*name="checklist-download"[\s\S]*?<\/form>/)?.[0] ?? '';
  assert.match(form, /netlify-honeypot="bot-field"/);
  assert.match(form, /name="bot-field"/);
  assert.match(form, /href="\/privacy"/, 'consent line must link the Privacy Policy');
  const handler = guide.match(/document\.addEventListener\('submit'[\s\S]*?\}\)\.catch/)?.[0] ?? '';
  assert.match(handler, /gtag\('event',\s*'checklist_requested'/);
  assert.ok(handler.indexOf("success.style.display = ''") < handler.indexOf('checklist_requested'), 'the lead event fires before the success state is shown');
});

// ── 2026-10-01 market snapshot sections (Phase 4c of the fix plan) ──────────
// Every market figure on these pages is a dated statistic from a named source. A figure
// with no source link, or a source nothing cites, is how a number outlives its evidence.

test('WP-27 each market snapshot figure cites a numbered source, every source is cited, and the section is dated', () => {
  for (const file of ['markets/columbus-oh.html', 'markets/maryland.html']) {
    const html = read(file);
    const section = html.match(/<section[^>]*id="market-snapshot"[\s\S]*?<\/section>/)?.[0];
    assert.ok(section, `${file}: no #market-snapshot section`);
    assert.match(section, /Updated quarterly/, `${file}: the snapshot must say it is dated and refreshed`);
    const cited = new Set([...section.matchAll(/<sup><a href="#mkt-(\d+)">/g)].map((m) => m[1]));
    const sources = new Map([...section.matchAll(/<li id="mkt-(\d+)"><a href="(https:\/\/[^"]+)"/g)].map((m) => [m[1], m[2]]));
    assert.ok(cited.size >= 4, `${file}: expected at least four cited figures, found ${cited.size}`);
    for (const n of cited) assert.ok(sources.has(n), `${file}: citation [${n}] has no source link`);
    for (const n of sources.keys()) assert.ok(cited.has(n), `${file}: source [${n}] is listed but nothing cites it`);
    assert.ok(/not Oxford(?:&rsquo;|')s buildings/.test(section), `${file}: the section must say the statistics are not Oxford's own figures`);
  }
});

// ── Broker-score wording & tenant-page market wording (2026-10-03 review pass) ──
// The portal returns an automated preliminary estimate, not a "graded
// investment score" from a verified 100-parameter model, so public copy must
// not claim either. The FAQ answer and its FAQPage JSON-LD must stay identical.

test('public pages do not claim a "graded investment score" or a "100-parameter" scorecard', () => {
  for (const file of htmlFiles()) {
    const html = read(file);
    assert.ok(!/graded investment score/i.test(html), `${file} still says "graded investment score"`);
    assert.ok(!/100-parameter/i.test(html), `${file} still claims a "100-parameter" scorecard`);
  }
});

test('for-brokers "How does Oxford evaluate a deal?" FAQ matches its JSON-LD answer', () => {
  const html = read('for-brokers.html');
  const ld = html.match(/"name": "How does Oxford evaluate a deal\?", "acceptedAnswer": \{"@type": "Answer", "text": "([^"]+)"/);
  assert.ok(ld, 'FAQPage JSON-LD entry for the evaluation question not found');
  assert.ok(html.includes(`<p>${ld[1]}</p>`), 'visible FAQ answer differs from the JSON-LD answer');
});

test('tenant-resources describes two core markets plus a Kansas City holding, not "three markets"', () => {
  const html = read('tenant-resources.html');
  assert.ok(!/three markets/i.test(html), 'tenant-resources.html still says "three markets"');
  assert.ok(/two core markets, plus a Kansas City holding/.test(html), 'tenant-resources.html lost the two-core-markets wording');
});

// ── Track Record case studies + broker "don't buy" / "why Oxford" (2026-10-03, PR B) ──
// Publishing rules (Gabriel): basis per SF only, no absolute NOI or estimated-value dollars,
// no ownership structure, no lender/loan wording, no tenant names. Broadway is medical
// retail at $49/SF per the settlement register ($1,350,000 / 27,650 SF).

test('track-record: seven studies each carry Situation / What we saw / What we did / Result', () => {
  const html = read('track-record.html');
  for (const label of ['Situation', 'What we saw', 'What we did', 'Result']) {
    const n = (html.match(new RegExp(`<strong>${label}\.</strong>`, 'g')) || []).length;
    assert.equal(n, 7, `expected 7 "${label}." lead-ins (3540 + four cards + 55 New Plant Ct + 7658 Fishel), found ${n}`);
  }
});

test('track-record: no ownership structure, lender wording, tenant names or absolute value tiles', () => {
  const html = read('track-record.html');
  assert.ok(!/joint venture|partnership/i.test(html), 'ownership structure wording on Track Record');
  assert.ok(!/\b(?:lender|loan|mortgage|LTV|non-recourse)\b/i.test(html), 'lender/loan wording on Track Record');
  assert.ok(!/honeywell/i.test(html), 'tenant name on Track Record');
  assert.ok(!/Est\. Current Value/i.test(html), 'absolute estimated-value tile is back');
  assert.ok(!/\$613K|\$175K/.test(html), 'absolute NOI dollar figure is back');
});

test('track-record: Broadway is $49/SF and labeled medical retail; New Plant Court and Fishel cards exist', () => {
  const html = read('track-record.html');
  assert.ok(/Baltimore, MD · 27,650 SF · Medical Retail/.test(html), 'Broadway must be labeled Medical Retail');
  const broadway = html.slice(html.indexOf('<h3>1900 North Broadway</h3>'), html.indexOf('<h3>55 New Plant Court</h3>'));
  assert.ok(broadway.includes('>$49</span>') && !broadway.includes('>$48</span>'), 'Broadway basis must be $49/SF');
  assert.ok(html.includes('<h3>55 New Plant Court</h3>') && html.includes('<h3>7658 Fishel Drive N</h3>'));
});

test('for-brokers: don\'t-buy block, "send it anyway" line and six why-Oxford cards', () => {
  const html = read('for-brokers.html');
  assert.ok(html.includes('What We Generally Don&rsquo;t Buy'), 'missing the don\'t-buy heading');
  assert.ok(html.includes('Not sure whether it fits? Send it anyway.'));
  assert.ok(html.includes('<h2>Why Brokers Send Us Deals</h2>'));
  assert.equal((html.match(/class="incentive-card animate-on-scroll"/g) || []).length, 6, 'expected six incentive cards');
});
