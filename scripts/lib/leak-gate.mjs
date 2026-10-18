/**
 * leak-gate.mjs — shared core for the Hard-Invariant-3 build gate.
 *
 * Active confidential deals must never reach any external surface, and this
 * repo is git-tracked off-machine, so a plain roster term may never appear in
 * it. The gate therefore compares SALTED HASHES of normalized roster terms
 * (scripts/leak-gate-hashes.json, written by scripts/leak-gate-hashes.mjs from
 * the machine-local roster) against hashes of the text of everything we ship.
 *
 * This module holds only the pure mechanics (normalize, hash, scan, file
 * dispatch). It contains no roster data and must never be given any in a
 * committed file. See docs/leak-gate.md.
 *
 * Matching model
 *   tokens(s)      NFKD, strip diacritics, drop trademark/superscript marks,
 *                  fold common Cyrillic/Greek look-alikes, lowercase,
 *                  tokens = [a-z0-9]+ runs.
 *   compact form   tokens joined with no separator, so spacing, hyphens and
 *                  punctuation variants of one name collapse to one string.
 *   scan           every run of consecutive tokens whose compacted length is
 *                  one a term has is HMAC'd and looked up. Terms of
 *                  >= SUBSTRING_MIN compact chars are also matched INSIDE a
 *                  single longer token (the roster's own matching is
 *                  substring-based).
 *   PDFs           additionally scanned as a glued character stream (Chromium
 *                  writes one glyph per operator, so word gaps are lost).
 *   kinds          always  -> hit on its own
 *                  context -> hit only with a ctxreq hit in the same document
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { extractPdfText, printableRuns } from './leak-gate-pdf.mjs';

export const MAX_WINDOW = 64; // tokens; the char-length bound below is what really limits a window
export const SUBSTRING_MIN = 10;
export const MAX_SUBSTRING_TOKEN = 4096; // only a sanity bound for pathological blobs
export const HASH_FILE_VERSION = 2;
export const KINDS = new Set(['always', 'context', 'ctxreq']);

// Look-alike letters that NFKD does not fold (Cyrillic and Greek to Latin).
const CONFUSABLES = new Map(
  Object.entries({
    а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w',
    α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y',
  })
);

export function tokens(text) {
  const t = String(text)
    .replace(/[®©℠-™²³¹⁰-₟]/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const LIG = { ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', ł: 'l', đ: 'd', ı: 'i', þ: 'th', ɪ: 'i', ӏ: 'i' };
  let folded = t.replace(/[øßæœłđıþɪӏ]/g, (c) => LIG[c]);
  if (/[^\u0000-ɏ]/.test(folded)) folded = [...folded].map((c) => CONFUSABLES.get(c) ?? c).join('');
  return folded.match(/[a-z0-9]+/g) || [];
}

export const compact = (term) => tokens(term).join('');

// HMAC-SHA256 truncated to 128 bits. createHmac costs ~27 us per call on Windows
// (OpenSSL init), which made a real scan take minutes; the same function computed
// from precomputed ipad/opad hash states is ~1 us. Output is byte-identical to
// crypto.createHmac (pinned by a test), so the committed file format is plain HMAC.
const hmacStates = new Map();
export function hmac(saltHex, s) {
  let st = hmacStates.get(saltHex);
  if (!st) {
    const key = Buffer.from(saltHex, 'hex');
    if (key.length > 64) return crypto.createHmac('sha256', key).update(s).digest('hex').slice(0, 32);
    const pad = (b) => Buffer.from(Buffer.alloc(64).map((_, i) => (i < key.length ? key[i] : 0) ^ b));
    st = { inner: crypto.createHash('sha256').update(pad(0x36)), outer: crypto.createHash('sha256').update(pad(0x5c)) };
    hmacStates.set(saltHex, st);
  }
  const innerDigest = st.inner.copy().update(s).digest();
  return st.outer.copy().update(innerDigest).digest('hex').slice(0, 32);
}

/** Build the committed denylist structure from plain terms. Never logs terms. */
export function buildDenylist(entries, saltHex) {
  const seen = new Set();
  const out = [];
  for (const { kind, term } of entries) {
    const c = compact(term);
    if (!c || !KINDS.has(kind)) continue;
    const key = kind + ':' + c;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, h: hmac(saltHex, c), len: c.length });
  }
  out.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.kind < b.kind ? -1 : 1));
  const file = {
    version: HASH_FILE_VERSION,
    algo: 'HMAC-SHA256 truncated to 128 bits; key = salt; message = compact normalized term',
    salt: saltHex,
    entries: out,
  };
  file.selfcheck = selfcheckOf(file);
  return file;
}

/** Binds the salt AND every entry, so a mixed-up or edited file fails validation. */
export function selfcheckOf(file) {
  return hmac(file.salt, 'leak-gate-selfcheck|' + file.entries.map((e) => `${e.kind}:${e.h}:${e.len}`).join('|'));
}

/** Digest of the active term set, for the local staleness check. */
export function rosterDigest(entries, saltHex) {
  const canon = [...new Set(entries.map((e) => e.kind + ':' + compact(e.term)).filter((x) => !x.endsWith(':')))].sort().join('\n');
  return hmac(saltHex, 'roster-digest\n' + canon);
}

/**
 * Flatten a parsed roster (confidential-terms.json) to its ACTIVE entries,
 * mirroring hooks/confidentiality-guard.py: a deal is active unless its
 * `active` key is present and falsy; a blank `context_requires_any` entry
 * leaves the deal's context terms UNANCHORED, i.e. they hit on their own.
 */
export function activeEntries(roster) {
  const out = [];
  for (const [key, deal] of Object.entries(roster)) {
    if (key.startsWith('_') || !deal || typeof deal !== 'object' || Array.isArray(deal)) continue;
    if ('active' in deal && !deal.active) continue;
    const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const anchors = strs(deal.context_requires_any);
    const unanchored = anchors.some((a) => !compact(a));
    for (const t of strs(deal.always)) out.push({ kind: 'always', term: t });
    for (const t of strs(deal.aliases)) out.push({ kind: 'always', term: t });
    for (const t of strs(deal.context)) out.push({ kind: unanchored ? 'always' : 'context', term: t });
    for (const t of anchors) out.push({ kind: 'ctxreq', term: t });
  }
  return out;
}

/** Validate and index the committed file for scanning. Throws on anything off. */
export function indexDenylist(file) {
  const bad = (why) => new Error('leak-gate hash file is missing or malformed: ' + why);
  if (!file || typeof file !== 'object' || file.version !== HASH_FILE_VERSION) throw bad('version');
  if (!/^[0-9a-f]{64}$/.test(file.salt || '')) throw bad('salt');
  if (!Array.isArray(file.entries)) throw bad('entries');
  if (file.selfcheck !== selfcheckOf(file)) throw bad('selfcheck (salt or entries were changed or mixed up)');
  const byHash = new Map();
  const lengths = new Set();
  for (const e of file.entries) {
    if (!e || !KINDS.has(e.kind) || !/^[0-9a-f]{32}$/.test(e.h) || !Number.isInteger(e.len) || e.len < 1 || e.len > 400) throw bad('entry');
    if (!byHash.has(e.h)) byHash.set(e.h, new Set());
    byHash.get(e.h).add(e.kind);
    lengths.add(e.len);
  }
  const maxLen = Math.max(0, ...lengths);
  const subLengths = [...lengths].filter((l) => l >= SUBSTRING_MIN);
  return { salt: file.salt, byHash, lengths, maxLen, subLengths, size: file.entries.length, cache: new Map() };
}

const CACHE_CAP = 600000;

// One keyed lookup, memoized across the whole run: pages share nav/footer text,
// so most windows repeat. Returns the kinds Set for a hit, else undefined.
function lookup(idx, w) {
  if (idx.cache.has(w)) return idx.cache.get(w);
  const k = idx.byHash.get(hmac(idx.salt, w));
  if (idx.cache.size < CACHE_CAP) idx.cache.set(w, k);
  return k;
}

const classify = (kinds) => {
  const hits = [];
  if (kinds.has('always')) hits.push('always');
  if (kinds.has('context') && kinds.has('ctxreq')) hits.push('context+ctxreq');
  return hits;
};

/**
 * Scan one document's text. Returns an array of hit classes
 * ('always' | 'context+ctxreq'); never the matched text.
 */
export function scanText(text, idx) {
  if (idx.size === 0) return [];
  const toks = tokens(text);
  const kinds = new Set();
  const look = (s) => {
    const k = lookup(idx, s);
    if (k) for (const x of k) kinds.add(x);
  };
  for (let i = 0; i < toks.length; i++) {
    let acc = '';
    for (let w = 0; w < MAX_WINDOW && i + w < toks.length; w++) {
      acc += toks[i + w];
      if (acc.length > idx.maxLen) break;
      if (idx.lengths.has(acc.length)) look(acc);
    }
    const t = toks[i];
    if (t.length <= MAX_SUBSTRING_TOKEN) {
      for (const L of idx.subLengths) {
        if (t.length > L) for (let j = 0; j + L <= t.length; j++) look(t.slice(j, j + L));
      }
    }
  }
  return classify(kinds);
}

/**
 * Substring scan over text with no word boundaries (PDF glyph streams): every
 * window of every denylist length is hashed. Fail-closed by design; short
 * terms can false-positive here (see docs/leak-gate.md).
 */
export function scanGlued(text, idx) {
  if (idx.size === 0) return [];
  const c = compact(text);
  const kinds = new Set();
  for (const L of idx.lengths) {
    for (let j = 0; j + L <= c.length; j++) {
      const k = lookup(idx, c.slice(j, j + L));
      if (k) for (const x of k) kinds.add(x);
    }
  }
  return classify(kinds);
}

export { extractPdfText, printableRuns };

/** Count of letters/digits, to detect "this PDF yielded no readable text". */
export const readableLength = (text) => compact(text).length;

/* -------------------------------------------------------------- file level */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic)$/i;
const BINARY_EXT = /\.(woff2?|ttf|otf|eot|mp4|mov|webm)$/i;
const CONTAINER_EXT = /\.(zip|docx|xlsx|pptx|jar|7z|rar|tar)$/i;
const COMPRESSED_EXT = /\.(gz|svgz|br)$/i;

const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');

function percentDecode(s) {
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
  });
}

/** Decode HTML entities, JS/JSON/CSS escapes and percent-encoding. Named entities that are not letters join their neighbours. */
const SPACE_ENT = /&(?:nbsp|ensp|emsp|thinsp|hairsp|mdash|ndash|middot|bull|amp|sol|bsol|hyphen|dash|lowbar|period|comma|colon|semi);/gi;

export function decodeEscapes(s, spaceEntities = false) {
  return percentDecode(
    (spaceEntities ? s.replace(SPACE_ENT, ' ') : s)
      .replace(/&([a-zA-Z])(?:grave|acute|circ|uml|tilde|ring|cedil|slash|caron|macr);/g, '$1')
      .replace(/&szlig;/g, 'ss')
      .replace(/&([aAoO])elig;/g, '$1e')
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => cp(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d) => cp(parseInt(d, 10)))
      .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, '')
      .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_, h) => cp(parseInt(h, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\([0-9a-f]{2,6})\s?/gi, (_, h) => cp(parseInt(h, 16)))
  );
}

function decodeTextBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    return b.subarray(0, b.length - (b.length % 2)).swap16().toString('utf16le');
  }
  return buf.toString('utf8');
}

/**
 * Scan one file. Returns { hits, kind, pathHit, problems[] }. `problems` are
 * fail-closed conditions (a file we cannot read), not term hits. The file's
 * repo-relative PATH is scanned too.
 */
export function scanFile(relPath, buf, idx) {
  const problems = [];
  const pathHits = scanText(decodeEscapes(relPath).replace(/[\\/]/g, ' '), idx);
  let kind = 'text';
  let variants;
  let gluedText = '';
  const extra = []; // hits from decompressed content
  if (/\.pdf$/i.test(relPath)) {
    kind = 'pdf';
    const { text, glued, readable, unsupported } = extractPdfText(buf);
    for (const u of unsupported) problems.push(`PDF content not decodable (${u}); cannot prove clean`);
    if (readableLength(readable) < 40) problems.push('PDF yielded no readable text; cannot prove clean');
    variants = [text];
    gluedText = glued;
  } else if (CONTAINER_EXT.test(relPath)) {
    kind = 'binary';
    problems.push('archive/office container is not unpacked; cannot prove clean');
    variants = [idx.size ? printableRuns(buf) : ""];
  } else if (COMPRESSED_EXT.test(relPath)) {
    kind = 'binary';
    let inner = null;
    try {
      inner = /\.br$/i.test(relPath) ? zlib.brotliDecompressSync(buf) : zlib.gunzipSync(buf);
    } catch {
      problems.push('compressed file could not be decompressed; cannot prove clean');
    }
    variants = [idx.size ? printableRuns(buf) : ""];
    if (inner) {
      const r = scanFile(relPath.replace(COMPRESSED_EXT, '') || 'inner', inner, idx);
      extra.push(...r.hits);
      problems.push(...r.problems);
    }
  } else if (IMAGE_EXT.test(relPath)) {
    kind = 'image';
    variants = [idx.size ? printableRuns(buf) : ""];
  } else if (BINARY_EXT.test(relPath) || (buf.subarray(0, 8192).includes(0) && !(buf[0] === 0xff && buf[1] === 0xfe) && !(buf[0] === 0xfe && buf[1] === 0xff))) {
    kind = 'binary';
    variants = [idx.size ? printableRuns(buf) : ""];
  } else {
    const raw = decodeTextBuffer(buf);
    variants = [raw];
    for (const dec of [decodeEscapes(raw), decodeEscapes(raw, true)]) {
      if (dec !== raw && !variants.includes(dec)) variants.push(dec);
      // Any text file may carry HTML (listings.js, JSON fragments, markdown), so tags are stripped everywhere.
      const stripped = dec.replace(/<[^>]*>/g, '');
      if (stripped !== dec && !variants.includes(stripped)) variants.push(stripped);
    }
  }
  const hits = new Set(pathHits.map((h) => 'path:' + h));
  for (const h of extra) hits.add(h);
  for (const v of variants) for (const h of scanText(v, idx)) hits.add(h);
  if (gluedText) for (const h of scanGlued(gluedText, idx)) hits.add('glued:' + h);
  return { kind, hits: [...hits], pathHit: pathHits.length > 0, problems };
}
