/**
 * leak-gate-pdf.mjs — dependency-free PDF text extraction for the leak gate.
 *
 * Not a general PDF reader: it inflates FlateDecode streams, reads the
 * ToUnicode CMaps, follows font-resource names to their CMap, and walks the
 * text operators. Chromium/Skia output (this repo's PDFs) writes ONE glyph per
 * Tj with a Td between, so the extractor returns two views:
 *   spaced  runs separated by spaces/newlines (word windows work on it)
 *   glued   every decoded character, no separators (substring windows work on
 *           it even when a name is spread over many single-glyph operators)
 * Unreadable constructs are reported in `unsupported`; the caller fails closed.
 */

import zlib from 'node:zlib';

const FLATE = new Set(['FlateDecode', 'Fl']);
const IMAGE_CODECS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);
const OTHER_FILTERS = new Set(['ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL', 'Crypt']);

export function printableRuns(buf, min = 4) {
  const runs = buf.toString('latin1').match(new RegExp(`[\\x20-\\x7e]{${min},}`, 'g')) || [];
  const re = new RegExp(`[\\x20-\\x7e]{${min},}`, 'g');
  // Even-length slices only: toString('utf16le') on an odd-length Buffer hard-crashes some Node builds.
  const even = (b) => b.subarray(0, b.length - (b.length % 2));
  const wide = even(buf).toString('utf16le').match(re) || [];
  const wideOdd = even(buf.subarray(1)).toString('utf16le').match(re) || [];
  return runs.concat(wide, wideOdd).join('\n');
}

function unescapeLiteral(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] || c)
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function hexToStr(h) {
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  if (h.length === 2) out = String.fromCharCode(parseInt(h, 16));
  return out;
}

export function parseCMap(text) {
  const map = new Map();
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), hexToStr(m[2]));
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi < lo || hi - lo > 0xffff) continue;
      if (m[3] !== undefined) {
        const base = hexToStr(m[3]);
        if (!base) continue;
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      } else {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToStr(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      }
    }
  }
  return map;
}

const be16 = (b) => Buffer.from(b.length % 2 ? Buffer.concat([b, Buffer.alloc(1)]) : b).swap16().toString('utf16le');

function decodeWith(cmap, bytes, width) {
  let out = '';
  for (let i = 0; i + width <= bytes.length; i += width) {
    let code = 0;
    for (let k = 0; k < width; k++) code = (code << 8) | bytes[i + k];
    out += cmap.get(code) ?? '';
  }
  return out;
}

const STR = /<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\()])*)\)|(-?\d+\.?\d*)/g;
// Order of appearance matters: font change, TJ array, simple show, newline ops.
const OPS =
  /(\/[^\s/[\]<>()]+)\s+[-\d.]+\s+Tf|\[((?:\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]*>|[^\]()<])*)\]\s*TJ|(<[0-9a-fA-F\s]*>|\((?:\\.|[^\\()])*\))\s*(?:Tj|'|")|\bET\b|\bT\*|\bT[dDm]\b/g;

function operandBytes(tok) {
  if (tok[0] === '<') {
    const hex = tok.slice(1, -1).replace(/\s+/g, '');
    return hex.length >= 2 ? Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex') : Buffer.alloc(0);
  }
  return Buffer.from(unescapeLiteral(tok.slice(1, -1)), 'latin1');
}

function toBytes(m) {
  if (m[1] !== undefined) {
    const hex = m[1].replace(/\s+/g, '');
    return hex.length >= 2 ? Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex') : Buffer.alloc(0);
  }
  return Buffer.from(unescapeLiteral(m[2]), 'latin1');
}

export function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  const unsupported = new Set();
  const decoded = [];
  const byObj = new Map();
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    if (raw.slice(Math.max(0, m.index - 3), m.index) === 'end') continue;
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) {
      unsupported.add('unterminated stream');
      break;
    }
    re.lastIndex = end + 9;
    const objAt = raw.lastIndexOf(' obj', m.index);
    const dict = raw.slice(Math.max(objAt, m.index - 4000), m.index);
    const num = /(\d+)\s+\d+$/.exec(raw.slice(Math.max(0, objAt - 24), objAt));
    const isImage = /\/Subtype\s*\/Image/.test(dict);
    const names = [...dict.matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]);
    const codec = names.some((n) => IMAGE_CODECS.has(n));
    const other = names.filter((n) => OTHER_FILTERS.has(n));
    let body = buf.subarray(start, end);
    if (codec || other.length) {
      if (!isImage) unsupported.add(codec ? 'image codec on non-image stream' : other.join(','));
      decoded.push(printableRuns(body));
      continue;
    }
    if (names.some((n) => FLATE.has(n))) {
      try {
        body = zlib.inflateSync(body);
      } catch {
        try {
          body = zlib.inflateSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch {
          unsupported.add('corrupt FlateDecode stream');
          continue;
        }
      }
    }
    const txt = isImage ? printableRuns(body) : body.toString('latin1');
    decoded.push(txt);
    if (num) byObj.set(num[1], txt);
  }
  if (/\/Encrypt\b/.test(raw)) unsupported.add('encrypted PDF');
  if (/\/ObjStm\b/.test(raw)) unsupported.add('object streams (font dictionaries may be hidden)');

  // font object -> CMap, resource name -> candidate CMaps
  const corpus = [raw, ...decoded].join('\n');
  const fontCmap = new Map();
  const objBody = new Map();
  for (const o of raw.matchAll(/(\d+)\s+\d+\s+obj\b((?:(?!endobj)[\s\S]){0,4000})/g)) {
    objBody.set(o[1], o[2]);
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(o[2]);
    if (tu && byObj.has(tu[1])) fontCmap.set(o[1], parseCMap(byObj.get(tu[1])));
    // A composite/Type3 font, or one remapped by /Differences, cannot be read back to text without ToUnicode.
    if (/\/Type\s*\/Font\b/.test(o[2]) && /\/Subtype\s*\/(Type0|Type3)\b|\/Differences\b/.test(o[2]) && !/\/ToUnicode\b/.test(o[2])) {
      unsupported.add('font without ToUnicode (its text cannot be mapped)');
    }
  }
  const allCmaps = decoded.filter((d) => /beginbfchar|beginbfrange/.test(d)).map(parseCMap);
  const nameCmaps = new Map();
  const fontDicts = [...corpus.matchAll(/\/Font\s*<<((?:(?!>>)[\s\S])*)>>/g)].map((x) => x[1]);
  for (const ind of corpus.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) if (objBody.has(ind[1])) fontDicts.push(objBody.get(ind[1]));
  for (const fd of fontDicts) {
    for (const p of fd.matchAll(/\/([^\s/[\]<>()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const cm = fontCmap.get(p[2]);
      if (!cm) continue;
      if (!nameCmaps.has(p[1])) nameCmaps.set(p[1], new Set());
      nameCmaps.get(p[1]).add(cm);
    }
  }

  // Compressed stream bodies are binary noise here; their decoded text is in `decoded`.
  const outside = raw.replace(/stream\r?\n[\s\S]*?endstream/g, ' ');
  const spaced = [outside, ...decoded];
  // Literal metadata strings may use octal escapes (and UTF-16BE with a NUL byte per letter).
  const unesc = unescapeLiteral(outside);
  spaced.push(unesc, unesc.replace(/\0/g, ''));
  // Metadata strings (Info /Title, outlines, annotation /Contents) are often <FEFF...> UTF-16BE hex.
  for (const hx of (outside + '\n' + decoded.join('\n')).matchAll(/<([0-9a-fA-F\s]{6,})>/g)) {
    const h = hx[1].replace(/\s+/g, '');
    const b = Buffer.from(h.length % 2 ? h + '0' : h, 'hex');
    spaced.push(b.toString('latin1'), be16(/^feff/i.test(h) ? b.subarray(2) : b));
  }
  const gluedBy = new Map();
  const glue = (key, v) => {
    if (!gluedBy.has(key)) gluedBy.set(key, []);
    gluedBy.get(key).push(v.replace(/\s+/g, ''));
  };
  const ids = new Map();
  const cmId = (cm) => {
    if (!ids.has(cm)) ids.set(cm, ids.size);
    return ids.get(cm);
  };
  const readable = [];
  for (const d of decoded) {
    if (!/\bBT\b/.test(d)) continue;
    let cms = allCmaps;
    let resolved = false;
    for (const o of d.matchAll(OPS)) {
      if (o[1] !== undefined) {
        const set = nameCmaps.get(o[1].slice(1));
        cms = set ? [...set] : allCmaps;
        resolved = Boolean(set);
        continue;
      }
      if (o[2] === undefined && o[3] === undefined) {
        spaced.push(' ');
        continue;
      }
      const parts = [];
      if (o[2] !== undefined) {
        for (const s of o[2].matchAll(STR)) {
          if (s[3] !== undefined) {
            if (parseFloat(s[3]) < -200) parts.push(null);
          } else parts.push(toBytes(s));
        }
      } else {
        parts.push(operandBytes(o[3]));
      }
      const run = (fn) => parts.map((p) => (p === null ? ' ' : fn(p))).join('');
      const l1 = run((b) => b.toString('latin1'));
      const w16 = run(be16);
      spaced.push(l1, w16);
      glue('latin1', l1);
      glue('be16', w16);
      if (!cms.length) readable.push(l1);
      for (const cm of cms) {
        const w2 = run((b) => decodeWith(cm, b, 2));
        const w1 = run((b) => decodeWith(cm, b, 1));
        spaced.push(w2, w1);
        glue(cm, w2);
        if (resolved && cm === cms[0]) glue('merged', w2);
        glue(`${cmId(cm)}:1`, w1);
        readable.push(w2);
      }
    }
  }
  // One glued stream per decoder (junctions between streams only add noise windows).
  const glued = [...gluedBy.values()].map((v) => v.join('')).join(' ');
  return { text: spaced.join(' '), glued, readable: readable.join(''), unsupported: [...unsupported] };
}
