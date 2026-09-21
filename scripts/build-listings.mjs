/**
 * build-listings.mjs — data/listings.json is the single source of truth for
 * available space. This regenerates the three committed copies of it:
 *
 *   1. listings.js                — the `var LISTINGS = [...]` block
 *   2. available-space.html       — the static fallback cards in #listingsPanel
 *                                   (what crawlers see before listings.js runs)
 *   3. available-space.html       — the id="listing-schema" JSON-LD ItemList
 *
 * The outputs stay committed (no deploy-time generation) so a listings PR shows
 * the exact served markup in its diff; `--check` fails `npm run verify` if any
 * copy drifts from the JSON.
 *
 * Run: node scripts/build-listings.mjs          (rewrite)
 *      node scripts/build-listings.mjs --check  (exit 1 on drift, write nothing)
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// rateType -> JSON-LD wording. An unknown type throws rather than guessing.
export const RATE_TYPES = { MG: 'modified gross', NNN: 'triple net', '+UTIL': 'plus utilities' };

const CARD_IMG_SIZES = '(max-width: 767px) 100vw, (max-width: 1023px) 32vw, 30vw';
const PIN_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const PHONE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>';
const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5"/></svg>';

// ── Validation ───────────────────────────────────────────────────────────────
const PROP_FIELDS = { id: 'number', name: 'string', city: 'string', state: 'string', market: 'string', category: 'string', lat: 'number', lng: 'number', img: 'string', imgW: 'number', slug: 'string', desc: 'string' };
const UNIT_FIELDS = { suite: 'string', sf: 'number', sfLabel: 'string', rate: 'string', rateType: 'string', use: 'string' };

export function validate(listings) {
  if (!Array.isArray(listings)) throw new Error('listings.json must be an array');
  const ids = new Set();
  const slugs = new Set();
  for (const p of listings) {
    const who = `listing "${p && p.name}"`;
    for (const [k, t] of Object.entries(PROP_FIELDS)) {
      if (typeof p[k] !== t || p[k] === '') throw new Error(`${who}: missing/invalid ${k}`);
    }
    if (ids.has(p.id) || slugs.has(p.slug)) throw new Error(`${who}: duplicate id or slug`);
    ids.add(p.id);
    slugs.add(p.slug);
    if (!Array.isArray(p.units) || p.units.length === 0) throw new Error(`${who}: units must be a non-empty array`);
    for (const u of p.units) {
      for (const [k, t] of Object.entries(UNIT_FIELDS)) {
        if (typeof u[k] !== t || u[k] === '') throw new Error(`${who} suite "${u && u.suite}": missing/invalid ${k}`);
      }
      if (!/^\$\d+\.\d{2}$/.test(u.rate)) throw new Error(`${who} suite "${u.suite}": rate must look like $12.34`);
      if (!(u.rateType in RATE_TYPES)) throw new Error(`${who} suite "${u.suite}": unknown rateType "${u.rateType}"`);
      if (u.sfMax !== undefined && !(typeof u.sfMax === 'number' && u.sfMax > u.sf)) throw new Error(`${who} suite "${u.suite}": sfMax must exceed sf`);
    }
  }
  return listings;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/–/g, '&ndash;').replace(/—/g, '&mdash;');
}
const fmtSF = (n) => n.toLocaleString('en-US') + ' SF';
const totalSF = (p) => p.units.reduce((s, u) => s + (u.sfMax || u.sf), 0);
const mailto = (subject) => 'mailto:info@oxfordra.net?subject=Inquiry%20-%20' + encodeURIComponent(subject);

// ── 1. listings.js block ─────────────────────────────────────────────────────
export function renderListingsBlock(listings) {
  validate(listings);
  const json = JSON.stringify(listings, null, 2)
    .replace(/[\s\S]/g, (c) => (c.charCodeAt(0) < 128 ? c : String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')))
    .split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
  return '  var LISTINGS = ' + json + ';\n';
}

// ── 2. Static fallback cards ─────────────────────────────────────────────────
function cardImg(p) {
  const alt = esc(`${p.name} — ${fmtSF(totalSF(p))} ${p.category} available in ${p.city}, ${p.state}`);
  const img = `<img src="${esc(p.img)}" alt="${alt}" width="400" height="250" loading="lazy" decoding="async">`;
  const base = p.img.replace(/\.jpe?g$/i, '');
  if (base === p.img) return [`            ${img}`];
  const srcset = (ext) => esc(`${base}-480w.${ext} 480w, ${base}.${ext} ${p.imgW}w`);
  return [
    '            <picture>',
    `              <source type="image/avif" srcset="${srcset('avif')}" sizes="${CARD_IMG_SIZES}">`,
    `              <source type="image/webp" srcset="${srcset('webp')}" sizes="${CARD_IMG_SIZES}">`,
    `              ${img}`,
    '            </picture>',
  ];
}

function card(p) {
  const multi = p.units.length > 1;
  const L = [];
  L.push(`        <article class="as-card" data-id="${p.id}">`);
  L.push('          <div class="as-card__img">');
  L.push(...cardImg(p));
  L.push(`            <span class="as-card__badge as-card__badge--available">${multi ? p.units.length + ' Spaces' : '1 Space'}</span>`);
  L.push('          </div>');
  L.push('          <div class="as-card__body">');
  L.push(`            <h2 class="as-card__title">${esc(p.name)}</h2>`);
  if (p.subtitle) L.push(`            <div class="as-card__subtitle">${esc(p.subtitle)}</div>`);
  L.push('            <div class="as-card__address">');
  L.push(`              ${PIN_SVG}`);
  L.push(`              ${esc(p.city)}, ${esc(p.state)}`);
  L.push('            </div>');
  L.push('            <div class="as-card__stats">');
  L.push(`              <span class="as-card__stat">${fmtSF(totalSF(p))} total</span>`);
  L.push(`              <span class="as-card__stat">${esc(p.category)}</span>`);
  L.push(`              <span class="as-card__stat">${esc(p.market)}</span>`);
  L.push('            </div>');
  if (multi) {
    L.push(`            <button class="as-card__expand" data-id="${p.id}" aria-expanded="false">`);
    L.push(`              <span>View ${p.units.length} Available Spaces</span>`);
    L.push(`              ${CHEVRON_SVG}`);
    L.push('            </button>');
    L.push('            <div class="as-card__units">');
    for (const u of p.units) {
      L.push(`              <div class="as-unit" data-pid="${p.id}" data-suite="${esc(u.suite)}">`);
      L.push(`                <div class="as-unit__suite"><span class="as-unit__label">Suite</span>${esc(u.suite)}</div>`);
      L.push(`                <div class="as-unit__sf"><span class="as-unit__label">Size</span>${esc(u.sfLabel)}</div>`);
      L.push(`                <div class="as-unit__use"><span class="as-unit__label">Use</span>${esc(u.use)}</div>`);
      L.push(`                <div class="as-unit__rate"><span class="as-unit__label">Asking</span>${esc(u.rate)} <span class="as-unit__rate-type">${esc(u.rateType)}</span></div>`);
      L.push(`                <a href="${mailto(p.name + ' Suite ' + u.suite)}" class="as-unit__inquire" aria-label="Inquire about Suite ${esc(u.suite)} at ${esc(p.name)}">Inquire</a>`);
      L.push('              </div>');
    }
    L.push('            </div>');
  } else {
    const u = p.units[0];
    L.push('            <div class="as-card__single-unit">');
    L.push('              <div class="as-unit-inline">');
    L.push(`                <div><span class="as-unit__label">Suite</span> ${esc(u.suite)}</div>`);
    L.push(`                <div><span class="as-unit__label">Size</span> ${esc(u.sfLabel)}</div>`);
    L.push(`                <div><span class="as-unit__label">Asking</span> ${esc(u.rate)} <span class="as-unit__rate-type">${esc(u.rateType)}</span></div>`);
    L.push('              </div>');
    L.push('            </div>');
  }
  L.push('            <div class="as-card__footer">');
  L.push(`              <a href="${mailto(p.name)}" class="as-card__cta" aria-label="Inquire about ${esc(p.name)}">Inquire</a>`);
  L.push('              <a href="tel:+13015126125" class="as-card__phone" title="Call 301.512.6125">');
  L.push(`                ${PHONE_SVG}`);
  L.push('              </a>');
  L.push('            </div>');
  L.push('          </div>');
  L.push('        </article>');
  return L.join('\n');
}

export function renderCards(listings) {
  validate(listings);
  return listings.map(card).join('\n') + '\n';
}

// ── 3. JSON-LD ───────────────────────────────────────────────────────────────
// Compact one-line-per-Offer serialisation ("k": v, ...) matching the page's
// hand-written style, so a listings diff is one line per changed unit.
function compact(v) {
  if (Array.isArray(v)) return '[' + v.map(compact).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + compact(x)).join(', ') + '}';
  return JSON.stringify(v);
}

export function renderSchema(listings) {
  validate(listings);
  const items = [];
  for (const p of listings) {
    for (const u of p.units) {
      const price = u.rate.slice(1);
      const floorSize = u.sfMax
        ? { '@type': 'QuantitativeValue', minValue: u.sf, maxValue: u.sfMax, unitCode: 'FTK' }
        : { '@type': 'QuantitativeValue', value: u.sf, unitCode: 'FTK' };
      items.push({
        '@type': 'ListItem', position: items.length + 1,
        item: {
          '@type': 'Offer', name: `${p.name}, Suite ${u.suite}`,
          url: `https://oxfordra.net/available-space#${p.slug}`,
          businessFunction: 'http://purl.org/goodrelations/v1#LeaseOut',
          price, priceCurrency: 'USD',
          priceSpecification: { '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', unitText: 'per SF per year, ' + RATE_TYPES[u.rateType] },
          itemOffered: {
            '@type': 'Place', name: p.subtitle ? `${p.name}, ${p.subtitle}` : p.name,
            address: { '@type': 'PostalAddress', addressLocality: p.city, addressRegion: p.state, addressCountry: 'US' },
            floorSize,
          },
        },
      });
    }
  }
  const out = [
    '    {',
    '      "@context": "https://schema.org",',
    '      "@type": "ItemList",',
    '      "name": "Available Industrial and Flex Space | Oxford Realty Advisors",',
    '      "itemListElement": [',
    items.map((i) => '        ' + compact(i)).join(',\n'),
    '      ]',
    '    }',
  ].join('\n') + '\n';
  return out.replace(/<\//g, '<\\/'); // never let data close the <script>
}

// ── Splicing ─────────────────────────────────────────────────────────────────
// Each target region must match exactly once; anything else means the page was
// restructured and the generator must be updated, not guess.
function splice(src, re, replacement, label) {
  const hits = src.match(new RegExp(re.source, re.flags.replace('g', '') + 'g')) || [];
  if (hits.length !== 1) throw new Error(`${label}: expected exactly 1 anchor match, found ${hits.length}`);
  return src.replace(re, (_m, open, close) => open + replacement + close);
}


const GENERATORS = {
  'listings.js': (src, listings) =>
    splice(src, /()  var LISTINGS = \[[\s\S]*?\n  \];\n()/, renderListingsBlock(listings), 'listings.js LISTINGS block'),
  'available-space.html': (src, listings, version) =>
    splice(
      splice(
        splice(src, /(<div class="as-listings" id="listingsPanel">\n)[\s\S]*?(        <div class="as-no-results" id="noResults")/, renderCards(listings), '#listingsPanel cards'),
        /(<script type="application\/ld\+json" id="listing-schema">\n)[\s\S]*?(    <\/script>)/, renderSchema(listings), 'listing-schema JSON-LD'),
      /(<script defer src="[/]listings[.]js[?]v=)[^"]*(")/, version, 'listings.js cache-buster'),
};

// _headers serves /*.js as immutable for a year, so listings.js must get a new
// URL whenever its content changes or returning visitors keep stale listings.
// Hash of the LF-normalised file: identical on Windows and CI checkouts.
export const listingsVersion = (listingsJs) =>
  createHash('sha256').update(listingsJs.replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);

// The sitemap entry for the page these generators rewrite. Search engines use
// <lastmod> to decide when to recrawl a page marked changefreq=weekly.
export const SITEMAP_LOC = 'https://oxfordra.net/available-space';

// Set <lastmod> for one <loc>; every other byte (and the EOL style) is untouched.
export function stampSitemapLastmod(xml, loc, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`sitemap lastmod must be an ISO date (YYYY-MM-DD), got "${date}"`);
  const re = new RegExp(`(<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>\\s*<lastmod>)[^<]*(</lastmod>)`, 'g');
  const hits = xml.match(re) || [];
  if (hits.length !== 1) throw new Error(`sitemap.xml: expected exactly 1 <loc>${loc}</loc> with a <lastmod>, found ${hits.length}`);
  return xml.replace(re, (_m, open, close) => open + date + close);
}

// Returns the files that differ from what listings.json generates; rewrites
// them when `write` is set (and, only then, stamps the sitemap <lastmod> so the
// weekly LoopNet sync tells crawlers the page changed). Every output, sitemap
// included, is computed before the first write, so a bad sitemap fails the run
// with nothing on disk changed. Preserves each file's existing line endings.
// `root` is injectable so tests can run the real write path on a scratch copy.
export async function generate({ write = false, today = new Date().toISOString().slice(0, 10), root = ROOT } = {}) {
  const listings = JSON.parse(await fs.readFile(path.join(root, 'data', 'listings.json'), 'utf8'));
  const drift = [];
  const writes = [];
  let version; // set by listings.js (first entry), consumed by available-space.html
  for (const [name, gen] of Object.entries(GENERATORS)) {
    const raw = await fs.readFile(path.join(root, name), 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lf = gen(raw.replace(/\r\n/g, '\n'), listings, version);
    if (name === 'listings.js') version = listingsVersion(lf);
    const next = lf.replace(/\n/g, eol);
    if (next !== raw) {
      drift.push(name);
      writes.push([path.join(root, name), next]);
    }
  }
  if (write && drift.length) {
    const file = path.join(root, 'sitemap.xml');
    const raw = await fs.readFile(file, 'utf8');
    const next = stampSitemapLastmod(raw, SITEMAP_LOC, today);
    if (next !== raw) writes.push([file, next]);
  }
  if (write) for (const [file, content] of writes) await fs.writeFile(file, content);
  return drift;
}

const run = (write) => generate({ write });
export const checkAll = () => generate({ write: false });

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  run(!check).then((drift) => {
    if (check && drift.length) {
      console.error(`[build-listings] FAIL: out of sync with data/listings.json: ${drift.join(', ')} -- run: node scripts/build-listings.mjs`);
      process.exit(1);
    }
    console.log(`[build-listings] ${check ? 'OK -- in sync' : drift.length ? 'rewrote ' + drift.join(', ') : 'OK -- nothing to change'}`);
  }).catch((err) => {
    console.error('[build-listings] FAIL:', err.message);
    process.exit(1);
  });
}
