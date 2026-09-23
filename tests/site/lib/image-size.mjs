// Reads intrinsic pixel dimensions from an image file's header, with no
// dependency. Shared by seo.test.mjs (Organization logo size) and
// site-integrity.test.mjs (og:image dimensions, srcset `w` descriptors).
// Covers every raster format the site ships: PNG, JPEG, WebP and AVIF.
import { readFileSync } from 'node:fs';

function png(buf) {
  return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpeg(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('JPEG has no SOF marker');
}

function webp(buf) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { type: 'webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  throw new Error(`unknown WebP chunk ${chunk}`);
}

// AVIF (ISOBMFF): the primary item's size is in an `ispe` property box. Grid
// images also carry per-tile `ispe` boxes, so take the largest.
function avif(buf) {
  let best = null;
  for (let i = buf.indexOf('ispe'); i !== -1; i = buf.indexOf('ispe', i + 4)) {
    const width = buf.readUInt32BE(i + 8), height = buf.readUInt32BE(i + 12);
    if (!best || width * height > best.width * best.height) best = { type: 'avif', width, height };
  }
  if (!best) throw new Error('AVIF has no ispe box');
  return best;
}

export function imageSize(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 1, 4) === 'PNG') return png(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf);
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return webp(buf);
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/.test(buf.toString('ascii', 8, 12))) return avif(buf);
  throw new Error(`${file}: unrecognized image format`);
}
