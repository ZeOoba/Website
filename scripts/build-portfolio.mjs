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

const GRID_RE = /<!-- portfolio:grid:begin -->[\s\S]*?<!-- portfolio:grid:end -->/;
const LD_RE = /<!-- portfolio:jsonld:begin -->[\s\S]*?<!-- portfolio:jsonld:end -->/;
const MIX_RE = /<!-- portfolio:mix:begin -->[\s\S]*?<!-- portfolio:mix:end -->/;
const FAQ_RE = /<!-- portfolio:faq:begin -->[\s\S]*?<!-- portfolio:faq:end -->/;

// Visible FAQ and its FAQPage JSON-LD are rendered from this one list, so the two
// can never differ. Every answer states only facts the site already publishes.
const FAQ = [
  {
    q: 'What does Oxford Realty Advisors own?',
    a: 'Oxford owns 513,000+ SF of shallow-bay industrial, flex and light industrial outdoor storage (IOS) space, plus a small share of retail and office, in two core markets, Maryland and Columbus (Ohio), plus a Kansas City (Missouri) holding.',
  },
  {
    q: 'What is shallow-bay industrial?',
    a: "Shallow-bay industrial buildings are small-format industrial and flex buildings, typically divided into multiple units that each have their own loading. In Oxford's portfolio, units generally run from about 1,500 to 15,000 SF with at-grade drive-in doors or truck-height docks.",
  },
  {
    q: 'Does Oxford sell the properties it buys?',
    a: 'Oxford is a family-owned firm that invests 100% proprietary capital and holds its properties for the long term.',
  },
  {
    q: 'Where can I see space available to lease?',
    a: 'Current suites across the portfolio are listed on the Available Space page, where you can also start a tenant application.',
  },
  {
    q: 'How do I sell a building to Oxford?',
    a: 'Brokers and owners can submit an offering memorandum or rent roll and get a preliminary indication of interest within 1 business day. Oxford buys all-cash and closes in 30 to 45 days.',
  },
];

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
// JSON for an inline <script type="application/ld+json">: "<" is escaped so a name
// containing "</script" cannot end the element early.
const ldJson = (o, indent) => JSON.stringify(o, null, indent).replace(/</g, '\\u003c');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const detailPath = (a) => `/properties/${slug(a.name)}`;
const typeKey = (a) => {
  const key = TYPE_KEYS[a.type];
  if (!key) throw new Error(`portfolio.json: no filter key for type "${a.type}" (${a.name})`);
  return key;
};

// Rough (S, W, N, E) bounds of the states the portfolio spans. They catch gross
// errors (swapped lat/lng, a missing minus sign, a pin in the wrong state); they
// do not prove a pin is on the building. Pins come from county parcel layers; see
// the geocoding note in the repo's memory before adding or moving one.
const STATE_BOUNDS = {
  OH: [38.4, -84.82, 42.33, -80.52],
  MD: [37.91, -79.49, 39.72, -75.05],
  MO: [35.99, -95.77, 40.61, -89.1],
};
const decimals = (n) => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2015-08" -> "Aug 2015" (the transaction-history spec's display convention).
export const fmtAcquired = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

export function validateAssets(assets) {
  const seen = new Map();
  for (const a of assets) {
    const who = `portfolio.json "${a.name}"`;
    // A mistyped market would drop the card from the grid and JSON-LD while the mix
    // bar still counted it; a duplicate or empty slug would collide on id and page file.
    if (!MARKETS.some((m) => m.key === a.market)) throw new Error(`${who}: market must be one of ${MARKETS.map((m) => m.key).join(', ')} (got ${JSON.stringify(a.market)})`);
    if (!Number.isInteger(a.sf) || a.sf <= 0) throw new Error(`${who}: sf must be a positive integer (got ${JSON.stringify(a.sf)})`);
    const s = slug(String(a.name));
    if (!s) throw new Error(`${who}: name produces an empty slug`);
    if (seen.has(s)) throw new Error(`${who}: slug "${s}" is also used by "${seen.get(s)}"`);
    seen.set(s, a.name);
    if (a.acquired !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(a.acquired)) {
      throw new Error(`${who}: acquired must be an ISO month like "2015-08" (got ${JSON.stringify(a.acquired)})`);
    }
    if (typeof a.lat !== 'number' || typeof a.lng !== 'number') throw new Error(`${who}: lat/lng required (numbers)`);
    if (decimals(a.lat) < 4 || decimals(a.lng) < 4) throw new Error(`${who}: lat/lng need >= 4 decimals (3 decimals is ~100 m, which is how pins ended up kilometres off). JSON drops a trailing zero, so a real 4-decimal value like 39.2290 reads as 3: take a 5th digit from the parcel centroid, never invent one`);
    const box = STATE_BOUNDS[a.state];
    if (!box) throw new Error(`${who}: no coordinate bounds for state "${a.state}"`);
    if (a.lat < box[0] || a.lat > box[2] || a.lng < box[1] || a.lng > box[3]) throw new Error(`${who}: ${a.lat},${a.lng} is outside ${a.state}`);
  }
}

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

// Spec chips for a card, derived ONLY from the sourced `detail.specs` (never typed by
// hand), so a chip can never claim something the property page does not state.
export function chipsFor(a) {
  const specs = Object.fromEntries((a.detail && a.detail.specs) || []);
  const text = Object.values(specs).join(' ');
  const chips = [];
  if (/multi-tenant/i.test(specs.Configuration || '')) chips.push('Multi-tenant');
  else if (/single-tenant/i.test(specs.Configuration || '')) chips.push('Single-tenant');
  if (/drive-in|drive-on/i.test(text)) chips.push('Drive-in doors');
  if (/truck-?(height|high)/i.test(text)) chips.push('Truck docks');
  if (specs['Ceiling height']) chips.push(`${specs['Ceiling height']} ceilings`);
  return chips.slice(0, 3);
}

// Share of gross SF by filter key, as whole percents that sum to exactly 100
// (largest-remainder rounding). Never a building count.
export function mixShares(assets) {
  const total = assets.reduce((n, a) => n + a.sf, 0);
  const keys = ['flex', 'ios', 'other'];
  const raw = keys.map((k) => (assets.filter((a) => typeKey(a) === k).reduce((n, a) => n + a.sf, 0) / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((n, v) => n + v, 0);
  raw
    .map((v, i) => ({ i, r: v - Math.floor(v) }))
    .sort((x, y) => y.r - x.r)
    .forEach(({ i }) => { if (left-- > 0) floors[i] += 1; });
  return Object.fromEntries(keys.map((k, i) => [k, floors[i]]));
}

const MIX_LABELS = { flex: 'Industrial &amp; flex', ios: 'Industrial + IOS', other: 'Retail &amp; office' };

function renderMix(assets) {
  const shares = mixShares(assets);
  const keys = ['flex', 'ios', 'other'];
  const aria = keys.map((k) => `${MIX_LABELS[k].replace('&amp;', '&')} ${shares[k]}%`).join(', ');
  const segs = keys.map((k) => `<span class="pf-mix__seg pf-mix__seg--${k}" style="flex-grow:${shares[k]}"></span>`).join('');
  const legend = keys
    .map((k) => `<li><span class="pf-mix__dot pf-mix__dot--${k}" aria-hidden="true"></span>${MIX_LABELS[k]} <strong>${shares[k]}%</strong></li>`)
    .join('\n');
  return `<!-- portfolio:mix:begin -->
<div class="pf-mix animate-on-scroll">
<h2 class="pf-mix__title">What We Own</h2>
<div class="pf-mix__bar" role="img" aria-label="Share of square footage: ${aria}">${segs}</div>
<ul class="pf-mix__legend">
${legend}
</ul>
<p class="pf-mix__note">Share of gross square footage. Shallow-bay industrial and flex is the core of the portfolio.</p>
</div>
<!-- portfolio:mix:end -->`;
}

function renderFaq() {
  const items = FAQ.map((f, i) => `<div class="faq-item">
<button class="faq-item__trigger" id="pf-faq-${i + 1}-trigger" aria-expanded="false" aria-controls="pf-faq-${i + 1}">
<span>${esc(f.q)}</span>
<svg class="faq-item__icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
</button>
<div class="faq-item__body" id="pf-faq-${i + 1}" role="region" aria-labelledby="pf-faq-${i + 1}-trigger">
<div class="faq-item__answer">
<p>${esc(f.a)}</p>
</div>
</div>
</div>`).join('\n\n');
  return `<!-- portfolio:faq:begin -->
<section class="section section--parchment" aria-label="Frequently asked questions about the Oxford portfolio">
<div class="container">
<div class="section__header animate-on-scroll">
<span class="section__label">FAQ</span>
<h2>About the Portfolio: Common Questions</h2>
</div>
<div class="faq-list animate-on-scroll">

${items}

</div>
</div>
</section>
<!-- portfolio:faq:end -->`;
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
  const chipList = chipsFor(a);
  const chips = chipList.length ? `\n<ul class="pf-chips" aria-label="Features">${chipList.map((c) => `<li class="pf-chip">${esc(c)}</li>`).join('')}</ul>` : '';
  const suites = a.listingSlug ? avail.get(a.listingSlug) || 0 : 0;
  const badge = suites
    ? `\n<a class="pf-card__avail" href="/available-space#${esc(a.listingSlug)}">${suites} suite${suites === 1 ? '' : 's'} available</a>`
    : '';
  // data-* feed the client-side table view (portfolio.js) so it never re-parses card text.
  const href = a.detail ? ` data-href="${detailPath(a)}"` : '';
  const availAttr = suites ? ` data-avail="${suites}" data-avail-href="/available-space#${esc(a.listingSlug)}"` : '';
  return `<article class="portfolio-card pf-card pf-card--${key} animate-on-scroll" id="${slug(a.name)}" data-market="${esc(a.market)}" data-type="${key}" data-name="${esc(a.name)}" data-location="${esc(a.city)}, ${esc(a.state)}" data-lat="${a.lat}" data-lng="${a.lng}" data-sf="${esc(a.sf)}" data-type-label="${esc(a.type)}"${href}${availAttr}>
${picture(a.image)}
<div class="portfolio-card__body">
<h3>${esc(a.name)}</h3>
<p class="portfolio-card__location">${esc(a.city)}, ${esc(a.state)}</p>
<div class="portfolio-card__meta">
<span>${fmtSf(a.sf)} SF</span>
<span>${esc(a.type)}</span>${a.acquired ? `\n<span>Acquired ${fmtAcquired(a.acquired)}</span>` : ''}
</div>${chips}${badge}${thesis}${more}
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
      url: a.detail ? `${origin}${detailPath(a)}` : `${origin}/portfolio#${slug(a.name)}`,
      image: `${origin}${a.image.src}`,
      address: { '@type': 'PostalAddress', addressLocality: a.city, addressRegion: a.state, addressCountry: 'US' },
      geo: { '@type': 'GeoCoordinates', latitude: a.lat, longitude: a.lng },
      floorSize: { '@type': 'QuantitativeValue', value: a.sf, unitCode: 'FTK' },
      additionalProperty: { '@type': 'PropertyValue', name: 'Property Type', value: a.type },
    },
  }));
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
  // One list item per line keeps the page diff and weight small.
  const lines = items.map((it) => `    ${ldJson(it)}`).join(',\n');
  const ld = `{\n  "@context": "https://schema.org",\n  "@type": "ItemList",\n  "name": "Oxford Realty Advisors Portfolio",\n  "itemListElement": [\n${lines}\n  ]\n}`;
  const faqScript = `<script type="application/ld+json">\n${ldJson(faq, 2)}\n</script>`;
  return `<!-- portfolio:jsonld:begin -->\n<script type="application/ld+json">\n${ld}\n</script>\n${faqScript}\n<!-- portfolio:jsonld:end -->`;
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

async function renderDetail(a, page, assets) {
  const d = a.detail;
  const s = slug(a.name);
  const url = `https://oxfordra.net${detailPath(a)}`;
  const title = `${a.name} | Oxford Realty Advisors`;
  if (title.length > 60) throw new Error(`detail title over 60 chars: "${title}"`);
  const desc = d.metaDescription;
  const descLen = [...desc].length;
  if (descLen < 140 || descLen > 160) throw new Error(`${a.name}: metaDescription is ${descLen} chars (need 140-160)`);
  const [marketLabel, marketHref] = MARKET_PAGES[a.market];
  // The page hero, og:image and Place image default to the card image. `detail.hero`
  // ({src, alt, sources}, same shape as `image`) overrides them for THIS page only, so an
  // owner photograph can lead the page while the /portfolio card keeps its own image.
  const heroImage = d.hero || a.image;
  if (d.hero && (!d.hero.src || !d.hero.alt || !Array.isArray(d.hero.sources) || !d.hero.sources.length)) {
    throw new Error(`${a.name}: detail.hero needs src, alt and sources`);
  }
  // Optional focal point ("50% 40%") for a photo whose subject sits off-centre: the hero is a
  // wide, short banner, so the default centre crop can cut off a building's roofline.
  if (d.hero && d.hero.position !== undefined && !/^\d{1,3}% \d{1,3}%$/.test(d.hero.position)) {
    throw new Error(`${a.name}: detail.hero.position must look like "50% 40%"`);
  }
  const heroPosition = d.hero && d.hero.position ? ` style="object-position:${d.hero.position}"` : '';
  const { width, height } = await jpegSize(heroImage.src);

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
  head = replaceOne(head, /<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="https://oxfordra.net${heroImage.src}">`, 'og:image');
  head = replaceOne(head, /<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="https://oxfordra.net${heroImage.src}">`, 'twitter:image');
  head = replaceOne(head, /<meta property="og:image:width" content="[^"]*">/, `<meta property="og:image:width" content="${width}">`, 'og:image:width');
  head = replaceOne(head, /<meta property="og:image:height" content="[^"]*">/, `<meta property="og:image:height" content="${height}">`, 'og:image:height');

  const avif = heroImage.sources.find((x) => x.type === 'image/avif');
  const preload = avif
    ? `<link rel="preload" as="image" type="image/avif" href="${esc(avif.srcset.split(',').pop().trim().split(' ')[0])}" imagesrcset="${esc(avif.srcset)}" imagesizes="100vw" fetchpriority="high">`
    : '';
  head = replaceOne(head, /<link rel="preload" as="image"[^>]*>/, preload, 'hero image preload');

  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://oxfordra.net/' },
    { '@type': 'ListItem', position: 2, name: 'Portfolio', item: 'https://oxfordra.net/portfolio' },
    { '@type': 'ListItem', position: 3, name: a.name, item: url },
  ] };
  const place = { '@context': 'https://schema.org', '@type': 'Place', name: a.name, url, image: `https://oxfordra.net${heroImage.src}`, description: d.summary[0],
    address: { '@type': 'PostalAddress', addressLocality: a.city, addressRegion: a.state, addressCountry: 'US' },
    geo: { '@type': 'GeoCoordinates', latitude: a.lat, longitude: a.lng },
    floorSize: { '@type': 'QuantitativeValue', value: a.sf, unitCode: 'FTK' },
    additionalProperty: { '@type': 'PropertyValue', name: 'Property Type', value: a.type } };
  const ld = [crumbs, place].map((o) => `<script type="application/ld+json">\n${ldJson(o, 2)}\n</script>`).join('\n');
  // The portfolio page's own BreadcrumbList (Home > Portfolio) must not survive
  // next to the property's three-level one.
  head = replaceOne(head, /<script type="application\/ld\+json">\s*\{\s*"@context": "https:\/\/schema\.org",\s*"@type": "BreadcrumbList"[\s\S]*?<\/script>\n/, '', 'portfolio BreadcrumbList');
  head = replaceOne(head, LD_RE, ld, 'portfolio:jsonld markers');

  const heroSources = heroImage.sources.map((x) => `<source type="${esc(x.type)}" srcset="${esc(x.srcset)}" sizes="100vw">`).join('\n');
  const hero = `<!-- ═══ PROPERTY HERO ═══ -->
<section class="subpage-hero" aria-label="${esc(a.name)}">
<div class="subpage-hero__bg">
<picture>
${heroSources}
<img src="${esc(heroImage.src)}" alt="${esc(heroImage.alt)}" width="${width}" height="${height}" decoding="async" fetchpriority="high"${heroPosition}>
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
  // Physical specifications only (loading, unit sizes, ceiling, site). Never prices,
  // NOI, debt, occupancy, tenant names or leasing contacts: those stay off the page.
  // Internal links to the other property pages in the same market.
  const related = assets.filter((x) => x.detail && x.market === a.market && x.name !== a.name);
  const relatedHtml = related.length
    ? `\n<h2 class="pf-detail__specs-title">More in ${esc(marketLabel)}</h2>\n<ul class="pf-related">\n${related.map((r) => `<li><a href="${detailPath(r)}">${esc(r.name)}</a><span>${fmtSf(r.sf)} SF &middot; ${esc(r.type)}</span></li>`).join('\n')}\n</ul>`
    : '';
  const specs = d.specs && d.specs.length
    ? `\n<h2 class="pf-detail__specs-title">Specifications</h2>\n<dl class="pf-detail__specs">\n${d.specs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('\n')}\n</dl>`
    : '';
  // Owner photographs for the detail page only (the card image is separate). Each entry
  // names an image set `<base>.{avif,webp,jpg}` plus `<base>-600w.{avif,webp}`, with its
  // real pixel size so the layout never shifts as it loads.
  const gallery = d.gallery && d.gallery.length
    ? `\n<div class="pf-gallery">\n${d.gallery.map((g) => {
      if (!g.base || !g.alt || !Number.isInteger(g.width) || !Number.isInteger(g.height)) throw new Error(`gallery entry on "${a.name}" needs base, alt, width, height`);
      const sizes = '(min-width: 900px) 700px, calc(100vw - 32px)';
      const set = (ext) => `${g.base}-600w.${ext} 600w, ${g.base}.${ext} ${g.width}w`;
      return `<figure class="pf-gallery__item">\n<picture>\n<source type="image/avif" srcset="${esc(set('avif'))}" sizes="${sizes}">\n<source type="image/webp" srcset="${esc(set('webp'))}" sizes="${sizes}">\n<img src="${esc(g.base)}.jpg" alt="${esc(g.alt)}" width="${g.width}" height="${g.height}" loading="lazy" decoding="async">\n</picture>\n</figure>`;
    }).join('\n')}\n</div>`
    : '';
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
</ul>${gallery}${specs}${relatedHtml}
<p class="pf-detail__more"><a href="/track-record">See how Oxford creates value across the portfolio &rarr;</a></p>
</div>
<section class="pf-detail__facts" aria-label="Property facts">
<h2>At a glance</h2>
<dl>
<div><dt>Location</dt><dd>${esc(a.city)}, ${esc(a.state)}</dd></div>
<div><dt>Size</dt><dd>${fmtSf(a.sf)} SF</dd></div>
<div><dt>Property type</dt><dd>${esc(a.type)}</dd></div>
<div><dt>Market</dt><dd>${market}</dd></div>${a.acquired ? `\n<div><dt>Acquired</dt><dd>${fmtAcquired(a.acquired)}</dd></div>` : ''}
<div><dt>Status</dt><dd>Current holding</dd></div>
</dl>
<a class="btn btn--outline btn--full" href="/portfolio?view=map#${s}">View on portfolio map</a>
<a class="pf-detail__back" href="/portfolio#${s}">Back to portfolio</a>
</section>
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
  if (![GRID_RE, LD_RE, MIX_RE, FAQ_RE].every((re) => re.test(src))) {
    throw new Error('portfolio.html is missing a portfolio:grid / jsonld / mix / faq marker pair');
  }
  validateAssets(assets);
  const avail = availabilityBySlug(listings);
  // A listing no portfolio card claims would silently lose its badge. Fail loudly
  // instead: whoever adds a property to listings.json adds the card (and its
  // `listingSlug`) to data/portfolio.json in the same change.
  const claimed = new Set(assets.map((a) => a.listingSlug).filter(Boolean));
  const orphans = [...avail.keys()].filter((s) => !claimed.has(s));
  if (orphans.length) {
    throw new Error(`data/listings.json has listings no data/portfolio.json asset claims via listingSlug: ${orphans.join(', ')}`);
  }
  return src
    .replace(GRID_RE, () => renderGrid(assets, avail))
    .replace(LD_RE, () => renderJsonLd(assets))
    .replace(MIX_RE, () => renderMix(assets))
    .replace(FAQ_RE, () => renderFaq());
}

export const PORTFOLIO_LOC = 'https://oxfordra.net/portfolio';

// Set <lastmod> for one <loc>; every other byte (and the EOL style) is untouched.
// Lives here (build-listings.mjs re-exports it) so both generators stamp the sitemap
// the same way and the result does not depend on which one runs first.
export function stampSitemapLastmod(xml, loc, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`sitemap lastmod must be an ISO date (YYYY-MM-DD), got "${date}"`);
  const re = new RegExp(`(<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>\\s*<lastmod>)[^<]*(</lastmod>)`, 'g');
  const hits = xml.match(re) || [];
  if (hits.length !== 1) throw new Error(`sitemap.xml: expected exactly 1 <loc>${loc}</loc> with a <lastmod>, found ${hits.length}`);
  return xml.replace(re, (_m, open, close) => open + date + close);
}

// Returns the files that differ from what data/portfolio.json generates; rewrites
// them when `write` is set (and stamps each changed page's sitemap <lastmod>).
// Every output is computed before the first write. Detail pages reuse the
// rendered portfolio page's chrome (head, nav, footer, inline blocks), so
// their CSP hashes can never drift from the portfolio page's.
// `root` is injectable so tests can run the real path on a scratch copy; hero
// images are always read from the real repo.
export async function generate({ write = false, today = new Date().toISOString().slice(0, 10), root = ROOT } = {}) {
  const page = path.join(root, 'portfolio.html');
  const detailDir = path.join(root, 'properties');
  const assets = JSON.parse(await fs.readFile(path.join(root, 'data', 'portfolio.json'), 'utf8'));
  const listings = JSON.parse(await fs.readFile(path.join(root, 'data', 'listings.json'), 'utf8'));
  const html = await fs.readFile(page, 'utf8');
  // Render from LF text (the working copy is CRLF on Windows, the index is LF); each
  // output is converted back to its own file's line endings below.
  const next = renderPortfolioPage(html.replace(/\r\n/g, '\n'), assets, listings);

  const writes = new Map([[page, next]]);
  for (const a of assets.filter((x) => x.detail)) {
    writes.set(path.join(detailDir, `${slug(a.name)}.html`), await renderDetail(a, next, assets));
  }

  // build-dist publishes the whole properties/ folder, so a page nothing generates
  // any more (asset renamed, removed, or its `detail` dropped) would ship and stay in
  // the sitemap. Never delete it for the author (archive, don't delete): fail instead.
  const onDisk = await fs.readdir(detailDir).catch(() => []);
  const stale = onDisk.filter((f) => /\.html?$/i.test(f) && !writes.has(path.join(detailDir, f)));
  if (stale.length) {
    throw new Error(`properties/ has pages data/portfolio.json no longer generates: ${stale.join(', ')} — move them to /archive/ and drop their sitemap and _redirects entries`);
  }

  // Each file keeps its own line endings (CRLF in a Windows working copy, LF in the
  // index and on Linux), like build-listings.mjs: comparing and writing in the
  // file's own style means a CRLF checkout shows no false drift and a write does
  // not flip its endings. A page that does not exist yet follows portfolio.html.
  const pageEol = html.includes('\r\n') ? '\r\n' : '\n';
  const drift = [];
  const out = [];
  for (const [file, content] of writes) {
    const cur = await fs.readFile(file, 'utf8').catch(() => null);
    const eol = cur === null ? pageEol : cur.includes('\r\n') ? '\r\n' : '\n';
    const next = content.replace(/\n/g, eol);
    if (cur !== next) {
      drift.push(path.relative(root, file).replace(/\\/g, '/'));
      out.push([file, next]);
    }
  }
  if (write && drift.length) {
    const sitemap = path.join(root, 'sitemap.xml');
    const raw = await fs.readFile(sitemap, 'utf8');
    let stamped = raw;
    for (const f of drift) {
      const loc = f === 'portfolio.html' ? PORTFOLIO_LOC : `https://oxfordra.net/${f.replace(/\.html$/, '')}`;
      stamped = stampSitemapLastmod(stamped, loc, today);
    }
    await fs.mkdir(detailDir, { recursive: true });
    // Sitemap first: if a page write then fails, the sitemap is merely ahead of the
    // page, and a rerun still rewrites the page. The other order loses the dates.
    if (stamped !== raw) await fs.writeFile(sitemap, stamped);
    for (const [file, next] of out) await fs.writeFile(file, next);
  }
  return drift;
}

async function main() {
  const check = process.argv.includes('--check');
  const drift = await generate({ write: !check });
  if (!drift.length) {
    console.log('build-portfolio: portfolio.html and property pages are up to date');
    return;
  }
  if (check) {
    console.error(`build-portfolio: out of sync with data/portfolio.json: ${drift.join(', ')} — run \`node scripts/build-portfolio.mjs\``);
    process.exit(1);
  }
  console.log(`build-portfolio: updated ${drift.join(', ')}`);
}

// Importable (build-listings.mjs) without running the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
