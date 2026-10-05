'use strict';
// Gabriel, 2026-10-05: the 3875-3883 E Livingston page leads with his own photograph
// (IMG_5185.jpg) instead of the CoStar-derived aerial. `detail.hero` overrides the hero,
// og:image and Place image for THAT PAGE ONLY; the /portfolio card keeps `image` (his
// 2026-09-23 decision about card images). The photo was taken on a phone, so its EXIF
// (including GPS) must not ship.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ASSETS = JSON.parse(read('data/portfolio.json'));
const livingston = ASSETS.find((a) => a.name === '3875-3883 E Livingston');
const HERO = '/images/28-hero-3875-3883-livingston.jpg';

test('the Livingston page leads with the owner photograph, in its hero, og:image, twitter:image and Place image', () => {
  assert.ok(livingston && livingston.detail.hero, 'detail.hero missing');
  assert.strictEqual(livingston.detail.hero.src, HERO);
  const page = read('properties/3875-3883-e-livingston.html');
  assert.match(page, new RegExp(`<img src="${HERO}" alt="[^"]+" width="1600" height="1200" decoding="async" fetchpriority="high" style="object-position:50% 40%">`));
  assert.ok(page.includes(`og:image" content="https://oxfordra.net${HERO}"`));
  assert.ok(page.includes(`twitter:image" content="https://oxfordra.net${HERO}"`));
  assert.ok(page.includes(`"image": "https://oxfordra.net${HERO}"`) || page.includes(`"image":"https://oxfordra.net${HERO}"`), 'Place JSON-LD image');
  assert.match(page, /rel="preload" as="image" type="image\/avif" href="\/images\/28-hero-3875-3883-livingston\.avif"/, 'hero preload');
  assert.doesNotMatch(page, /12-aerial-view-3875-livingston/, 'the old aerial must not appear on the page');
  assert.match(livingston.detail.hero.alt, /^[^]{20,}$/, 'alt text is descriptive');
  assert.doesNotMatch(livingston.detail.hero.alt, /\b(people|person|man|woman)\b/i);
});

test('the /portfolio card keeps its own image, and no other page uses the new hero', () => {
  assert.strictEqual(livingston.image.src, '/images/12-aerial-view-3875-livingston.jpg');
  assert.ok(read('portfolio.html').includes('12-aerial-view-3875-livingston'), 'the card lost its image');
  for (const f of fs.readdirSync(path.join(ROOT, 'properties')).filter((n) => n.endsWith('.html') && n !== '3875-3883-e-livingston.html')) {
    assert.ok(!read(`properties/${f}`).includes('28-hero-3875-3883-livingston'), `${f} uses the Livingston hero`);
  }
  assert.ok(!read('portfolio.html').includes('28-hero-3875-3883-livingston'), 'the card must not use the page hero');
});

test('the hero image set exists at three widths, is a sensible weight, and carries no EXIF/GPS', () => {
  const base = '28-hero-3875-3883-livingston';
  const files = ['.jpg', '.avif', '.webp', '-900w.avif', '-900w.webp', '-480w.avif', '-480w.webp'].map((s) => `images/${base}${s}`);
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} missing`);
    assert.ok(fs.statSync(path.join(ROOT, f)).size < 450 * 1024, `${f} is over 450 KB`);
  }
  const jpg = fs.readFileSync(path.join(ROOT, `images/${base}.jpg`));
  assert.ok(!jpg.includes(Buffer.from('Exif')), 'the JPEG still carries EXIF (camera data / GPS)');
  assert.ok(!jpg.includes(Buffer.from('GPS')), 'the JPEG still mentions GPS');
  // Every srcset entry points at a file that ships.
  for (const s of livingston.detail.hero.sources) {
    for (const part of s.srcset.split(',')) {
      const file = part.trim().split(' ')[0];
      assert.ok(fs.existsSync(path.join(ROOT, file.replace(/^\//, ''))), `${file} in srcset does not exist`);
    }
  }
});

test('the generator rejects a malformed hero override', async () => {
  const src = read('scripts/build-portfolio.mjs');
  assert.match(src, /detail\.hero needs src, alt and sources/);
  assert.match(src, /detail\.hero\.position must look like/);
});
