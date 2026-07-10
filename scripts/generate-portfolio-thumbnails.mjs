/**
 * generate-portfolio-thumbnails.mjs — one-off asset generator for the
 * portfolio.html card grid (see fix/portfolio-responsive-images).
 *
 * The card grid renders each photo at a fixed 400px width (>=1024px
 * breakpoint) or up to full viewport width below that, but every card
 * <source> pointed at the same full-resolution master used by the page
 * hero, shipping ~700-800px-wide AVIF/WebP to a 400px box. This generates
 * a 400w derivative alongside each existing master (kept as the ~2x /
 * wide-mobile variant) so portfolio.html can use a width-descriptor
 * srcset. Idempotent: re-run any time the masters change.
 *
 * Run via: node scripts/generate-portfolio-thumbnails.mjs
 */

import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const IMAGES_DIR = path.join(ROOT, 'images');
const THUMB_WIDTH = 400;

// Every portfolio-grid card image, basename only (no extension). Mirrors
// the <picture> sources in portfolio.html — add a new card's image here
// when adding one there.
const CARD_IMAGES = [
  '20-9050-red-branch-exterior',
  '14-aerial-55-new-plant-court',
  '08-20161026_120215',
  '06-exterior-beauty',
  '03-exterior-nice-photo',
  '18-401-sunburst-hwy-main-picture',
  '09-3540-rear-exterior-1',
  '04-1100-rarig-exterior-2-drive-ins-dock',
  '01-2800-2826-banwick-exterior',
  '07-2000_2002-front',
  '10-zettler-2012-2026-exterior-',
  '17-warehouse-columbus-external',
  '11-gate-building',
  '16-exterior-docks-2-7658-fishel', // no AVIF master -- webp/jpg only
  '12-aerial-view-3875-livingston',
  '19-4601-e-5th-ave-exterior-1',
  '13-4595-towards-front-drive-in-door_',
  '05-exterior-front',
];

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function generateOne(basename, format) {
  const srcPath = path.join(IMAGES_DIR, `${basename}.${format}`);
  if (!(await exists(srcPath))) return null; // e.g. no .avif master for this card
  const outPath = path.join(IMAGES_DIR, `${basename}-${THUMB_WIDTH}w.${format}`);
  const srcMeta = await sharp(srcPath).metadata();
  if (srcMeta.width <= THUMB_WIDTH) {
    console.log(`[thumbnails] skip ${basename}.${format} — master is only ${srcMeta.width}px wide, not upscaling`);
    return null;
  }
  const pipeline = sharp(srcPath).resize({ width: THUMB_WIDTH });
  const buf = format === 'avif' ? await pipeline.avif({ quality: 55 }).toBuffer()
    : await pipeline.webp({ quality: 70 }).toBuffer();
  await fs.writeFile(outPath, buf);
  return { outPath, bytes: buf.length, srcBytes: (await fs.stat(srcPath)).size };
}

async function main() {
  let count = 0;
  let savedBytes = 0;
  for (const basename of CARD_IMAGES) {
    for (const format of ['avif', 'webp']) {
      const result = await generateOne(basename, format);
      if (result) {
        count += 1;
        savedBytes += Math.max(0, result.srcBytes - result.bytes);
        console.log(`[thumbnails] ${path.basename(result.outPath)} — ${Math.round(result.bytes / 1024)}KB (master was ${Math.round(result.srcBytes / 1024)}KB)`);
      }
    }
  }
  console.log(`[thumbnails] generated ${count} derivatives`);
}

main().catch((err) => {
  console.error('[thumbnails] FAIL:', err);
  process.exit(1);
});
