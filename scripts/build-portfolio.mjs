/**
 * build-portfolio.mjs — renders portfolio.html's property grid and ItemList
 * JSON-LD from data/portfolio.json (the single source for the page).
 *
 * The rendered markup is committed (the site is static HTML), so a PR diff shows
 * exactly what ships. `--check` fails `npm run build` when portfolio.html has
 * drifted from the data file, so the two cannot disagree.
 *
 *   node scripts/build-portfolio.mjs           rewrite portfolio.html
 *   node scripts/build-portfolio.mjs --check   exit 1 on drift, write nothing
 *
 * Publishing rules baked in here (see data/portfolio.json for the facts):
 *   - No building/property count is ever rendered (Master Workbook OI-4).
 *   - Per-market SF is rounded and prefixed "~" because card SF is gross and
 *     includes two 50%-owned assets.
 *   - A thesis line renders only where the data file carries one.
 *   - Availability badges come from data/listings.json via each asset's
 *     `listingSlug`. build-listings.mjs also regenerates portfolio.html (through
 *     renderPortfolioPage), so the weekly LoopNet sync keeps the badges current.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'portfolio.html');
const DATA = path.join(ROOT, 'data', 'portfolio.json');
const LISTINGS = path.join(ROOT, 'data', 'listings.json');
const DETAIL_DIR = path.join(ROOT, 'properties');

const GRID_RE = /<!-- portfolio:grid:begin -->[\s\S]*?<!-- portfolio:grid:end -->/;
const LD_RE = /<!-- portfolio:jsonld:begin -->[\s\S]*?<!-- portfolio:jsonld:end -->/;

// Render order of the market groups. `key` matches `market` in the data file.
const MARKETS = [
  { key: 'Maryland', heading: 'Maryland Industrial &amp; Flex Properties', href: '/markets/maryland', linkLabel: 'Maryland Overview' },
  { key: 'Ohio', heading: 'Columbus, Ohio Industrial &amp; Flex Properties', href: '/markets/columbus-oh', linkLabel: 'Columbus Overview' },
  { key: 'Missouri', heading: 'Kansas City Industrial &amp; Flex Property', href: null, linkLabel: null },
];

// Filter taxonomy: every data `type` maps to exactly one filter key.
const TYPE_KEYS = {
  Industrial: 'flex',
  'Industrial/Flex': 'flex',
  'Industrial + IOS': 'ios',
  'Medical Retail': 'other',
  'Auto-Service Retail': 'other',
  'Office/Retail': 'other',
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtSf = (n) => n.toLocaleString('en-US');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const detailPath = (a) => `/properties/${slug(a.name)}`;
const typeKey = (a) => {
  const key = TYPE_KEYS[a.type];
  if (!key) throw new Error(`portfolio.json: no filter key for type "${a.type}" (${a.name})`);
  return key;
};

// "~259K SF": rounded to the nearest thousand, never an exact figure.
const roughSf = (n) => `~${Math.round(n / 1000)}K SF`;

function picture(img) {
  const sizes = '(max-width: 767px) 100vw, (max-width: 1023px) 50vw, 400px';
  const sources = img.sources
    .map((s) => {
      const multi = s.srcset.includes(' ');
      return `<source type="${esc(s.type)}" srcset="${esc(s.srcset)}"${multi ? ` sizes="${sizes}"` : ''}>`;
    })
    .join('\n');
  return `<picture>\n${sources}\n<img src="${esc(img.src)}" alt="${esc(img.alt)}" width="400" height="250" loading="lazy" decoding="async">\n</picture>`;
}

// Suites currently listed per listings.json slug. A property with no listing
// (everything leased) has no entry, so it renders no badge.
export function availabilityBySlug(listings) {
  return new Map(listings.map((p) => [p.slug, p.units.length]));
}

function card(a, avail) {
  const key = typeKey(a);
  const thesis = a.thesis ? `\n<p class="pf-card__thesis">${esc(a.thesis)}</p>` : '';
  const more = a.detail ? `\n<a class="pf-card__more" href="${detailPath(a)}">Property details &rarr;</a>` : '';
  const suites = a.listingSlug ? avail.get(a.listingSlug) || 0 : 0;
  const badge = suites
    ? `\n<a class="pf-card__avail" href="/available-space#${esc(a.listingSlug)}">${suites} suite${suites === 1 ? '' : 's'} available</a>`
    : '';
  // data-* feed the client-side table view (portfolio.js) so it never re-parses card text.
  const href = a.detail ? ` data-href="${detailPath(a)}"` : '';
  const availAttr = suites ? ` data-avail="${suites}" data-avail-href="/available-space#${esc(a.listingSlug)}"` : '';
  return `<article class="portfolio-card pf-card pf-card--${key} animate-on-scroll" id="${slug(a.name)}" data-market="${esc(a.market)}" data-type="${key}" data-name="${esc(a.name)}" data-location="${esc(a.city)}, ${esc(a.state)}" data-sf="${a.sf}" data-type-label="${esc(a.type)}"${href}${availAttr}>
${picture(a.image)}
<div class="portfolio-card__body">
<h3>${esc(a.name)}</h3>
<p class="portfolio-card__location">${esc(a.city)}, ${esc(a.state)}</p>
<div class="portfolio-card__meta">
<span>${fmtSf(a.sf)} SF</span>
<span>${esc(a.type)}</span>
</div>${badge}${thesis}${more}
</div>
</article>`;
}

function renderGrid(assets, avail) {
  const groups = MARKETS.map((m) => {
    const inMarket = assets.filter((a) => a.market === m.key);
    if (!inMarket.length) throw new Error(`portfolio.json: no assets for market "${m.key}"`);
    // Industrial/flex/IOS first, other holdings last; data-file order otherwise.
    const ordered = [...inMarket].sort((x, y) => (typeKey(x) === 'other') - (typeKey(y) === 'other'));
    const total = inMarket.reduce((n, a) => n + a.sf, 0);
    const link = m.href
      ? `\n<a class="pf-group__link" href="${m.href}">${m.linkLabel} &rarr;</a>`
      : '';
    return `<section class="pf-group" data-market-group="${esc(m.key)}" aria-labelledby="pf-${slug(m.key)}">
<header class="pf-group__head">
<h2 id="pf-${slug(m.key)}">${m.heading}</h2>
<span class="pf-group__sf">${roughSf(total)}</span>${link}
</header>
<div class="portfolio-grid">
${ordered.map((a) => card(a, avail)).join('\n')}
</div>
</section>`;
  });
  return `<!-- portfolio:grid:begin -->\n${groups.join('\n')}\n<!-- portfolio:grid:end -->`;
}

function renderJsonLd(assets) {
  const origin = 'https://oxfordra.net';
  const items = MARKETS.flatMap((m) =>
    assets
      .filter((a) => a.market === m.key)
      .sort((x, y) => (typeKey(x) === 'other') - (typeKey(y) === 'other'))
  ).map((a, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'Place',
      name: a.name,
      url: `${origin}/portfolio#${slug(a.name)}`,
      image: `${origin}${a.image.src}`,
      address: { '@type': 'PostalAddress', addressLocality: a.city, addressRegion: a.state, addressCountry: 'US' },
      floorSize: { '@type': 'QuantitativeValue', value: a.sf, unitCode: 'FTK' },
      additionalProperty: { '@type': 'PropertyValue', name: 'Property Type', value: a.type },
    },
  }));
  // One list item per line keeps the page diff and weight small.
  const lines = items.map((it) => `    ${JSON.stringify(it)}`).join(',\n');
  const ld = `{\n  "@context": "https://schema.org",\n  "@type": "ItemList",\n  "name": "Oxford Realty Advisors Portfolio",\n  "itemListElement": [\n${lines}\n  ]\n}`;
  return `<!-- portfolio:jsonld:begin -->\n<script type="application/ld+json">\n${ld}\n</script>\n<!-- portfolio:jsonld:end -->`;
}

// Real pixel size of a JPEG, read from its SOF marker (og:image dimensions
// must match the file; site-integrity.test.mjs enforces it).
async function jpegSize(rel) {
  const buf = await fs.readFile(path.join(ROOT, rel.replace(/^\//, '')));
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error(`could not read JPEG size of ${rel}`);
}

function replaceOne(str, re, replacement, what) {
  if (!re.test(str)) throw new Error(`portfolio.html template: could not find ${what}`);
  return str.replace(re, () => replacement);
}

const MARKET_PAGES = { Maryland: ['Maryland', '/markets/maryland'], Ohio: ['Columbus, OH', '/markets/columbus-oh'], Missouri: ['Kansas City, MO', null] };

async function renderDetail(a, page) {
  const d = a.detail;
  const s = slug(a.name);
  const url = `https://oxfordra.net${detailPath(a)}`;
  const title = `${a.name} | Oxford Realty Advisors`;
  if (title.length > 60) throw new Error(`detail title over 60 chars: "${title}"`);
  const desc = d.metaDescription;
  const descLen = [...desc].length;
  if (descLen < 140 || descLen > 160) throw new Error(`${a.name}: metaDescription is ${descLen} chars (need 140-160)`);
  const [marketLabel, marketHref] = MARKET_PAGES[a.market];
  const { width, height } = await jpegSize(a.image.src);

  const bodyAt = page.indexOf('<body>');
  const mainAt = page.indexOf('<main id="main-content">');
  const nextAt = page.indexOf('<section class="section section--navy" aria-label="Next steps">');
  if (bodyAt < 0 || mainAt < 0 || nextAt < 0) throw new Error('portfolio.html template: body/main/next-steps anchors not found');

  let head = page.slice(0, bodyAt);
  const oldTitle = head.match(/<title>([^<]*)<\/title>/)[1];
  head = head.split(oldTitle).join(esc(title));
  head = replaceOne(head, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`, 'meta description');
  head = replaceOne(head, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`, 'og:description');
  head = replaceOne(head, /<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(desc)}">`, 'twitter:description');
  head = replaceOne(head, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`, 'canonical');
  head = replaceOne(head, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`, 'og:url');
  head = replaceOne(head, /<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="https://oxfordra.net${a.image.src}">`, 'og:image');
  head = replaceOne(head, /<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="https://oxfordra.net${a.image.src}">`, 'twitter:image');
  head = replaceOne(head, /<meta property="og:image:width" content="[^"]*">/, `<meta property="og:image:width" content="${width}">`, 'og:image:width');
  head = replaceOne(head, /<meta property="og:image:height" content="[^"]*">/, `<meta property="og:image:height" content="${height}">`, 'og:image:height');

  const avif = a.image.sources.find((x) => x.type === 'image/avif');
  const preload = avif
    ? `<link rel="preload" as="image" type="image/avif" href="${esc(avif.srcset.split(',').pop().trim().split(' ')[0])}" imagesrcset="${esc(avif.srcset)}" imagesizes="100vw" fetchpriority="high">`
    : '';
  head = replaceOne(head, /<link rel="preload" as="image"[^>]*>/, preload, 'hero image preload');

  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://oxfordra.net/' },
    { '@type': 'ListItem', position: 2, name: 'Portfolio', item: 'https://oxfordra.net/portfolio' },
    { '@type': 'ListItem', position: 3, name: a.name, item: url },
  ] };
  const place = { '@context': 'https://schema.org', '@type': 'Place', name: a.name, url, image: `https://oxfordra.net${a.image.src}`, description: d.summary[0],
    address: { '@type': 'PostalAddress', addressLocality: a.city, addressRegion: a.state, addressCountry: 'US' },
    floorSize: { '@type': 'QuantitativeValue', value: a.sf, unitCode: 'FTK' },
    additionalProperty: { '@type': 'PropertyValue', name: 'Property Type', value: a.type } };
  const ld = [crumbs, place].map((o) => `<script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n</script>`).join('\n');
  // The portfolio page's own BreadcrumbList (Home > Portfolio) must not survive
  // next to the property's three-level one.
  head = replaceOne(head, /<script type="application\/ld\+json">\s*\{\s*"@context": "https:\/\/schema\.org",\s*"@type": "BreadcrumbList"[\s\S]*?<\/script>\n/, '', 'portfolio BreadcrumbList');
  head = replaceOne(head, LD_RE, ld, 'portfolio:jsonld markers');

  const heroSources = a.image.sources.map((x) => `<source type="${esc(x.type)}" srcset="${esc(x.srcset)}" sizes="100vw">`).join('\n');
  const hero = `<!-- ═══ PROPERTY HERO ═══ -->
<section class="subpage-hero" aria-label="${esc(a.name)}">
<div class="subpage-hero__bg">
<picture>
${heroSources}
<img src="${esc(a.image.src)}" alt="${esc(a.image.alt)}" width="${width}" height="${height}" decoding="async" fetchpriority="high">
</picture>
</div>
<div class="subpage-hero__overlay"></div>
<div class="subpage-hero__content">
<span class="section__label section__label--light">Portfolio &middot; ${esc(marketLabel)}</span>
<h1>${esc(a.name)}</h1>
<p>${esc(a.city)}, ${esc(a.state)} &middot; ${fmtSf(a.sf)} SF &middot; ${esc(a.type)}</p>
</div>
</section>
`;
  const market = marketHref ? `<a href="${marketHref}">${esc(marketLabel)}</a>` : esc(marketLabel);
  const body = `<!-- ═══ PROPERTY DETAIL ═══ -->
<section class="section" aria-label="Property detail">
<div class="container pf-detail">
<nav class="pf-crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span aria-hidden="true">/</span> <a href="/portfolio">Portfolio</a> <span aria-hidden="true">/</span> <span aria-current="page">${esc(a.name)}</span></nav>
<div class="pf-detail__grid">
<div class="pf-detail__main">
<h2>About this property</h2>
${d.summary.map((p) => `<p>${esc(p)}</p>`).join('\n')}
<ul class="pf-detail__highlights">
${d.highlights.map((h) => `<li>${esc(h)}</li>`).join('\n')}
</ul>
<p class="pf-detail__more"><a href="/track-record">See how Oxford creates value across the portfolio &rarr;</a></p>
</div>
<aside class="pf-detail__facts" aria-label="Property facts">
<h2>At a glance</h2>
<dl>
<div><dt>Location</dt><dd>${esc(a.city)}, ${esc(a.state)}</dd></div>
<div><dt>Size</dt><dd>${fmtSf(a.sf)} SF</dd></div>
<div><dt>Property type</dt><dd>${esc(a.type)}</dd></div>
<div><dt>Market</dt><dd>${market}</dd></div>
<div><dt>Status</dt><dd>Current holding</dd></div>
</dl>
<a class="btn btn--outline btn--full" href="/portfolio#${s}">Back to portfolio</a>
</aside>
</div>
</div>
</section>

`;
  const tail = page.slice(nextAt).replace(/<script defer src="\/portfolio\.js\?v=\d+"><\/script>\n?/, '');
  return `${head}${page.slice(bodyAt, mainAt)}<main id="main-content">\n\n${hero}\n${body}${tail}`;
}

// The whole portfolio.html this data produces. Pure (LF text in, LF text out) so
// build-listings.mjs can regenerate the page too: the availability badges depend
// on data/listings.json, which the weekly LoopNet sync rewrites.
export function renderPortfolioPage(src, assets, listings) {
  if (!GRID_RE.test(src) || !LD_RE.test(src)) {
    throw new Error('portfolio.html is missing the portfolio:grid / portfolio:jsonld markers');
  }
  const avail = availabilityBySlug(listings);
  // A listing no portfolio card claims would silently lose its badge. Fail loudly
  // instead: whoever adds a property to listings.json adds the card (and its
  // `listingSlug`) to data/portfolio.json in the same change.
  const claimed = new Set(assets.map((a) => a.listingSlug).filter(Boolean));
  const orphans = [...avail.keys()].filter((s) => !claimed.has(s));
  if (orphans.length) {
    throw new Error(`data/listings.json has listings no data/portfolio.json asset claims via listingSlug: ${orphans.join(', ')}`);
  }
  return src.replace(GRID_RE, () => renderGrid(assets, avail)).replace(LD_RE, () => renderJsonLd(assets));
}

async function main() {
  const check = process.argv.includes('--check');
  const assets = JSON.parse(await fs.readFile(DATA, 'utf8'));
  const listings = JSON.parse(await fs.readFile(LISTINGS, 'utf8'));
  const html = await fs.readFile(PAGE, 'utf8');
  // The working copy is CRLF on Windows; the index is LF. Compare and write LF.
  const src = html.replace(/\r\n/g, '\n');
  const next = renderPortfolioPage(src, assets, listings);

  // Every output is computed before the first write. Detail pages reuse the
  // rendered portfolio page's chrome (head, nav, footer, inline blocks), so
  // their CSP hashes can never drift from the portfolio page's.
  const writes = new Map([[PAGE, next]]);
  for (const a of assets.filter((x) => x.detail)) {
    writes.set(path.join(DETAIL_DIR, `${slug(a.name)}.html`), await renderDetail(a, next));
  }

  const drift = [];
  for (const [file, content] of writes) {
    const cur = await fs.readFile(file, 'utf8').then((t) => t.replace(/\r\n/g, '\n'), () => null);
    if (cur !== content) drift.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  }
  if (!drift.length) {
    console.log('build-portfolio: portfolio.html and property pages are up to date');
    return;
  }
  if (check) {
    console.error(`build-portfolio: out of sync with data/portfolio.json: ${drift.join(', ')} — run \`node scripts/build-portfolio.mjs\``);
    process.exit(1);
  }
  await fs.mkdir(DETAIL_DIR, { recursive: true });
  for (const [file, content] of writes) await fs.writeFile(file, content);
  console.log(`build-portfolio: updated ${drift.join(', ')}`);
}

// Importable (build-listings.mjs) without running the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
