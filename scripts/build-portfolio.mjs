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
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'portfolio.html');
const DATA = path.join(ROOT, 'data', 'portfolio.json');

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

function card(a) {
  const key = typeKey(a);
  const thesis = a.thesis ? `\n<p class="pf-card__thesis">${esc(a.thesis)}</p>` : '';
  return `<article class="portfolio-card pf-card pf-card--${key} animate-on-scroll" id="${slug(a.name)}" data-market="${esc(a.market)}" data-type="${key}">
${picture(a.image)}
<div class="portfolio-card__body">
<h3>${esc(a.name)}</h3>
<p class="portfolio-card__location">${esc(a.city)}, ${esc(a.state)}</p>
<div class="portfolio-card__meta">
<span>${fmtSf(a.sf)} SF</span>
<span>${esc(a.type)}</span>
</div>${thesis}
</div>
</article>`;
}

function renderGrid(assets) {
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
${ordered.map(card).join('\n')}
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

async function main() {
  const check = process.argv.includes('--check');
  const assets = JSON.parse(await fs.readFile(DATA, 'utf8'));
  const html = await fs.readFile(PAGE, 'utf8');
  // The working copy is CRLF on Windows; the index is LF. Compare and write LF.
  const src = html.replace(/\r\n/g, '\n');
  if (!GRID_RE.test(src) || !LD_RE.test(src)) {
    throw new Error('portfolio.html is missing the portfolio:grid / portfolio:jsonld markers');
  }
  const next = src.replace(GRID_RE, () => renderGrid(assets)).replace(LD_RE, () => renderJsonLd(assets));
  if (next === src) {
    console.log('build-portfolio: portfolio.html is up to date');
    return;
  }
  if (check) {
    console.error('build-portfolio: portfolio.html has drifted from data/portfolio.json — run `node scripts/build-portfolio.mjs`');
    process.exit(1);
  }
  await fs.writeFile(PAGE, next);
  console.log('build-portfolio: portfolio.html updated');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
