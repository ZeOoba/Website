'use strict';
// Single home for the broker OM intake limits, so the session mint, finalize, scoring download, text
// extraction and the LLM prompt builder cannot drift apart. CommonJS with node builtins only: this is
// reached from ESM function entries, and a bare-package require here would be left unresolved by
// esbuild (see tests/functions/esm-cjs-bundling-contract.test.js).
const zlib = require('node:zlib');

// ---------- Upload ----------
// The browser uploads straight to SharePoint, so the server never sees the bytes at session time and the
// size is only the broker's claim. broker-finalize re-checks it against the size Graph reports.
const OM_UPLOAD_EXTS = ['pdf', 'xlsx', 'xls', 'doc', 'docx'];
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

// Anthropic caps a document-block request at 32MB/100 pages and base64 inflates a raw file ~33% - 20MB raw
// stays safely under that after encoding. Anything larger skips scoring (the submission itself still lands).
const MAX_SCORING_BYTES = 20 * 1024 * 1024;

// ---------- Text extraction (XLSX/DOCX -> LLM prompt) ----------
// Soft caps: over these the text is cut deterministically and a visible marker is appended, so the model
// (and anyone reading the stored text) can see content was dropped. ~200K chars is roughly 50K tokens.
const MAX_EXTRACTED_SHEETS = 25;
const MAX_ROWS_PER_SHEET = 2000;
const MAX_COLS_PER_SHEET = 256;
// mammoth builds a DOM roughly 100x the size of word/document.xml (5 MB of XML peaked at ~740 MB), so docx XML
// parts are bounded far below the generic per-entry cap.
const MAX_DOCX_XML_BYTES = 3 * 1024 * 1024;
// mammoth holds document, footnotes, endnotes and comments DOMs at once, so the SUM is bounded as well.
const MAX_DOCX_XML_TOTAL_BYTES = 6 * 1024 * 1024;
// SheetJS creates a cell object for every address in a hyperlink / HLink range, whatever sheetRows says, so a
// 1 KB file can declare A1:XFD1048576. Anything beyond the extraction window is not an OM hyperlink.
const MAX_HYPERLINK_AREA = 2000 * 256;

// Isolated parse (child process): wall-clock and V8 heap ceilings for XLSX.read / mammoth. The pre-scans above are
// cheap first filters; these are the actual bound.
const PARSE_TIMEOUT_MS = 15_000;
// Budget for a 1 GB function: parent ~100 MB + child V8 heap + child off-heap (the inflated zip buffers, up to
// MAX_ZIP_UNCOMPRESSED_BYTES, plus the byte copy of the upload) + the caller's own inspectZip buffers/strings
// (a few hundred MB while it runs). Measured peaks: 512 MB heap -> ~980 MB combined; 384 MB heap -> ~940 MB with
// 3x48 MB padded XML; a 217 KB xlsx reached ~800 MB in the child alone. Hence 256 MB here and an 80 MB inflate cap.
const PARSE_HEAP_MB = 256;
const MAX_EXTRACTED_CHARS = 200_000;

// ---------- Archive bounds (zip-bomb defence) ----------
// Hard caps: over these the file fails closed (no parse, no LLM call). A 20 MB OM workbook legitimately
// expands to tens of MB of XML; hundreds of MB, thousands of parts, or an entry that inflates past its
// own header is not an OM.
const MAX_ZIP_ENTRIES = 2000;
// 48 MB: a legitimate 18 MB workbook expands to ~66 MB in total (~13 MB per sheet part); an 85 MB sharedStrings.xml
// took ~9 s and >1 GB to parse.
const MAX_ZIP_ENTRY_BYTES = 48 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;

function truncationMarker(detail) {
  return `\n\n[TRUNCATED: ${detail}. Content beyond this point was dropped and is NOT reflected in this extraction.]`;
}

// Cuts `text` to `max` chars and appends the marker. Deterministic: same input, same output. The result is
// always `max` chars of content plus the marker, never shorter than the input would have been under the cap.
function capText(text, max, detail) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + truncationMarker(detail || `text exceeded ${max} characters`), truncated: true };
}

// ---------- Declared-type vs real bytes ----------
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEAD_BYTES = OLE2_MAGIC.length;

function startsWith(buf, sig) {
  return Boolean(buf) && buf.length >= sig.length && sig.every((b, i) => buf[i] === b);
}

// True only when the leading bytes are a signature the declared extension can legitimately carry:
// pdf -> %PDF; docx -> ZIP (OOXML); spreadsheets and legacy doc -> ZIP or OLE2 (an .xlsx that is really a
// legacy workbook, or an .xls saved as OOXML, has always been accepted and still is).
function matchesDeclaredOmType(ext, head) {
  switch (ext) {
    case 'pdf': return startsWith(head, PDF_MAGIC);
    case 'docx': return startsWith(head, ZIP_MAGIC);
    case 'xlsx':
    case 'xls':
    case 'doc': return startsWith(head, ZIP_MAGIC) || startsWith(head, OLE2_MAGIC);
    default: return false;
  }
}

// ---------- Finalize-time plausibility ----------
// Intake is deliberately more lenient than scoring: a file that fails the strict check above still reaches
// Gabriel as a lead (scoring just reports "unavailable"). Password-protected OOXML is stored as OLE2, a "doc"
// may really be RTF, and rent-roll exports named .xls are often HTML/XML/CSV, so unrecognised ("other")
// leading bytes are allowed. Only a signature that positively identifies a DIFFERENT or hostile format is
// refused: an executable/script, a PDF posing as an Office file, or an Office/zip container posing as a PDF.
function classifyHead(head) {
  if (startsWith(head, PDF_MAGIC)) return 'pdf';
  if (startsWith(head, ZIP_MAGIC)) return 'zip';
  if (startsWith(head, OLE2_MAGIC)) return 'ole2';
  if (startsWith(head, [0x4d, 0x5a])) return 'exe'; // MZ (PE)
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'exe'; // ELF
  if (startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(head, [0xca, 0xfe, 0xba, 0xbe])) return 'exe'; // Mach-O / Java class
  if (startsWith(head, [0x23, 0x21])) return 'exe'; // #! script
  return 'other';
}

const PLAUSIBLE_KINDS = {
  pdf: ['pdf', 'other'],
  docx: ['zip', 'ole2', 'other'],
  xlsx: ['zip', 'ole2', 'other'],
  xls: ['zip', 'ole2', 'other'],
  doc: ['zip', 'ole2', 'other'],
};

function isPlausibleOmUpload(ext, head) {
  const allowed = PLAUSIBLE_KINDS[ext];
  return Boolean(allowed) && allowed.includes(classifyHead(head));
}

// SheetJS overrides an entry's sizes from a ZIP64 extra field (id 0x0001) in BOTH the central and the local
// header, then allocates the declared size up front. The 4-byte size fields we validate are then irrelevant.
// Archives this small never need ZIP64, so any 0x0001 field, or an extra block that does not parse cleanly,
// fails closed.
function extraFieldsSafe(buffer, start, length) {
  if (length === 0) return true;
  const end = start + length;
  if (end > buffer.length) return false;
  let p = start;
  while (p < end) {
    if (p + 4 > end) return false;
    const id = buffer.readUInt16LE(p);
    const size = buffer.readUInt16LE(p + 2);
    if (id === 0x0001) return false;
    p += 4 + size;
  }
  return p === end;
}

// ---------- Zip inspection ----------
// SheetJS and mammoth/JSZip do NOT agree with each other (or with a naive reader) about where the archive's
// structure lives: SheetJS scans for the end-of-central-directory record from the last 4 bytes and trusts each
// LOCAL header over the central directory, then inflates with no output limit. So this check is deliberately
// strict and fails closed on ANY disagreement:
//   - exactly one EOCD, and it must end the file (no hidden second EOCD in a comment or trailer);
//   - every local header must agree with its central-directory entry (method, sizes);
//   - entry data ranges must not overlap (stops a few KB being counted once per entry);
//   - declared sizes, entry count and per-entry size are capped, then every entry is actually inflated with a
//     hard output ceiling equal to its declared size, so a header that understates a payload cannot hide it.
// Returns { ok: true } or { ok: false, reason } where reason is a short machine code.
function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Total area (cells) of all <hyperlink ref="A1:B2"> tags in a worksheet part. LINEAR by construction: it walks the
// string with indexOf, each tag is cut at its own '>' (and at 4096 chars) before the regex sees it, and the walk
// always advances past that '>' - a lazy regex run over the whole part rescanned to the end of the string for every
// '<hyperlink ' that lacked a closing '>' (a 4.5 KB zip held the caller for 91 s).
// Anchored with ^: unanchored, exec() retried from every '<hyperlink' inside the cut tag (quadratic: 25 s for a 336 KB zip).
const HYPERLINK_REF = /^<hyperlink\b[^>]*?\bref="([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?"/;
const HYPERLINK_TAG_MAX = 4096;
function totalHyperlinkArea(xml) {
  let total = 0;
  let i = 0;
  while (true) {
    i = xml.indexOf('<hyperlink', i);
    if (i === -1) break;
    const end = xml.indexOf('>', i);
    if (end === -1) break;
    const m = HYPERLINK_REF.exec(xml.slice(i, Math.min(end, i + HYPERLINK_TAG_MAX)));
    if (m) {
      const c1 = colToNum(m[1]); const r1 = Number(m[2]);
      const c2 = m[3] ? colToNum(m[3]) : c1; const r2 = m[4] ? Number(m[4]) : r1;
      total += (Math.abs(c2 - c1) + 1) * (Math.abs(r2 - r1) + 1); // SUM, not max
    }
    i = end + 1;
  }
  return total;
}

function inspectZip(buffer, { requireContentTypes = false, maxXmlEntryBytes = Infinity, maxXmlTotalBytes = Infinity } = {}) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) return { ok: false, reason: 'zip_malformed' };
    // Highest-offset EOCD signature, scanned from len-4 like SheetJS does (not len-22), so a fake record
    // tucked inside the real one's comment is the one we examine.
    const floor = Math.max(0, buffer.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buffer.length - 4; i >= floor; i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0 || eocd + 22 > buffer.length) return { ok: false, reason: 'zip_malformed' };
    // Office writes no archive comment, so any comment (or trailing byte) is refused outright.
    if (buffer.readUInt16LE(eocd + 20) !== 0 || eocd + 22 !== buffer.length) return { ok: false, reason: 'zip_malformed' };
    // Single-disk archive only, and the two entry counts must agree: SheetJS loops on the this-disk count
    // (+8) while this check and JSZip use the total (+10), so a mismatch hides entries from one reader.
    if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) return { ok: false, reason: 'zip_malformed' };
    if (buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)) return { ok: false, reason: 'zip_inconsistent' };
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const cdSize = buffer.readUInt32LE(eocd + 12);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { ok: false, reason: 'zip64_unsupported' };
    if (entryCount === 0) return { ok: false, reason: 'zip_malformed' };
    if (entryCount > MAX_ZIP_ENTRIES) return { ok: false, reason: 'zip_too_many_entries' };
    // The central directory must end exactly where the EOCD starts: no spare central records for a reader
    // that ignores the count (JSZip reads records until the signature stops) to find.
    if (cdOffset + cdSize !== eocd) return { ok: false, reason: 'zip_malformed' };

    const entries = [];
    let pos = cdOffset;
    let declaredTotal = 0;
    for (let n = 0; n < entryCount; n += 1) {
      if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) return { ok: false, reason: 'zip_malformed' };
      const method = buffer.readUInt16LE(pos + 10);
      const compSize = buffer.readUInt32LE(pos + 20);
      const rawSize = buffer.readUInt32LE(pos + 24);
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);
      const localOffset = buffer.readUInt32LE(pos + 42);
      if (compSize === 0xffffffff || rawSize === 0xffffffff || localOffset === 0xffffffff) return { ok: false, reason: 'zip64_unsupported' };
      if (rawSize > MAX_ZIP_ENTRY_BYTES) return { ok: false, reason: 'zip_entry_too_large' };
      declaredTotal += rawSize;
      if (declaredTotal > MAX_ZIP_UNCOMPRESSED_BYTES) return { ok: false, reason: 'zip_too_large_uncompressed' };
      entries.push({ method, compSize, rawSize, localOffset, nameBytes: buffer.subarray(pos + 46, pos + 46 + nameLen) });
      if (!extraFieldsSafe(buffer, pos + 46 + nameLen, extraLen)) return { ok: false, reason: 'zip_inconsistent' };
      pos += 46 + nameLen + extraLen + commentLen;
    }

    if (pos !== eocd) return { ok: false, reason: 'zip_malformed' };

    // Resolve each entry's data range from its LOCAL header, and require the local header to agree.
    for (const e of entries) {
      const lo = e.localOffset;
      if (lo + 30 > buffer.length || buffer.readUInt32LE(lo) !== 0x04034b50) return { ok: false, reason: 'zip_malformed' };
      const flags = buffer.readUInt16LE(lo + 6);
      const localMethod = buffer.readUInt16LE(lo + 8);
      const localComp = buffer.readUInt32LE(lo + 18);
      const localRaw = buffer.readUInt32LE(lo + 22);
      if (localMethod !== e.method) return { ok: false, reason: 'zip_inconsistent' };
      const descriptor = (flags & 0x8) !== 0;
      const sizesAgree = localComp === e.compSize && localRaw === e.rawSize;
      const sizesDeferred = descriptor && localComp === 0 && localRaw === 0;
      if (!sizesAgree && !sizesDeferred) return { ok: false, reason: 'zip_inconsistent' };
      const localNameLen = buffer.readUInt16LE(lo + 26);
      // SheetJS resolves entries by the LOCAL name, JSZip by the central one: they must be the same bytes.
      if (localNameLen !== e.nameBytes.length || !buffer.subarray(lo + 30, lo + 30 + localNameLen).equals(e.nameBytes)) return { ok: false, reason: 'zip_inconsistent' };
      const localExtraLen = buffer.readUInt16LE(lo + 28);
      if (!extraFieldsSafe(buffer, lo + 30 + localNameLen, localExtraLen)) return { ok: false, reason: 'zip_inconsistent' };
      e.start = lo + 30 + localNameLen + localExtraLen;
      e.end = e.start + e.compSize;
      if (e.end > cdOffset) return { ok: false, reason: 'zip_malformed' };
    }
    // SheetJS decides what a zip IS from its entry names, and two of its non-OOXML branches re-enter the parser
    // or run a quadratic decoder that none of the byte-level checks here bound: a nested "Index.zip" is read
    // again as a whole new archive, and an Apple Numbers ".iwa" goes through a Snappy decoder that is
    // quadratic in its op count. An OM is OOXML, so require [Content_Types].xml and refuse those names.
    let hasContentTypes = false;
    let xmlTotal = 0;
    for (const e of entries) {
      const name = e.nameBytes.toString('latin1').toLowerCase().split(String.fromCharCode(92)).join('/');
      const base = name.slice(name.lastIndexOf('/') + 1);
      // SheetJS CFB.find matches by basename, case-insensitively, and dispatches to ODS / Numbers / Index.zip
      // branches BEFORE it looks at [Content_Types].xml. The ODS parser expands repeat counts into cell objects.
      if (base === 'index.zip' || base.endsWith('.iwa') || base === 'objectdata.xml' || base === 'index.xml' || base === 'index.xml.gz' || name === 'meta-inf/manifest.xml') return { ok: false, reason: 'zip_unsupported_content' };
      if (name === '[content_types].xml') hasContentTypes = true;
      if (base.endsWith('.xml') || base.endsWith('.rels')) {
        xmlTotal += e.rawSize;
        if (e.rawSize > maxXmlEntryBytes || xmlTotal > maxXmlTotalBytes) return { ok: false, reason: 'zip_entry_too_large' };
      }
      // xlsb: its worksheet records (BrtHLink) expand ranges the same way and are not an OM format.
      if (requireContentTypes && (name === 'xl/workbook.bin' || (name.startsWith('xl/worksheets/') && base.endsWith('.bin')))) return { ok: false, reason: 'zip_unsupported_content' };
      e.sheetXml = requireContentTypes && /^xl\/worksheets\/[^/]+\.xml$/.test(name);
    }
    if (requireContentTypes && !hasContentTypes) return { ok: false, reason: 'zip_unsupported_content' };

    const byOffset = entries.slice().sort((a, b) => a.localOffset - b.localOffset);
    for (let k = 1; k < byOffset.length; k += 1) {
      if (byOffset[k].localOffset < byOffset[k - 1].end) return { ok: false, reason: 'zip_overlap' };
    }

    for (const e of entries) {
      const data = buffer.subarray(e.start, e.end);
      let content = null;
      if (e.method === 0) {
        if (e.compSize !== e.rawSize) return { ok: false, reason: 'zip_inconsistent' };
        content = data;
      } else if (e.method === 8) {
        // maxOutputLength must be >= 1. Output beyond the declared size throws instead of allocating.
        const out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.rawSize, 1) });
        if (out.length !== e.rawSize) return { ok: false, reason: 'zip_size_mismatch' };
        content = out;
      } else {
        return { ok: false, reason: 'zip_unsupported_method' };
      }
      if (e.sheetXml && totalHyperlinkArea(content.toString('latin1')) > MAX_HYPERLINK_AREA) return { ok: false, reason: 'zip_unsupported_content' };
    }
    return { ok: true };
  } catch {
    // Any inflate failure, including ERR_BUFFER_TOO_LARGE from a header that understates its payload.
    return { ok: false, reason: 'zip_bomb_or_corrupt' };
  }
}

module.exports = {
  OM_UPLOAD_EXTS, MAX_UPLOAD_BYTES, MAX_SCORING_BYTES,
  MAX_EXTRACTED_SHEETS, MAX_ROWS_PER_SHEET, MAX_COLS_PER_SHEET, MAX_DOCX_XML_BYTES, MAX_DOCX_XML_TOTAL_BYTES, MAX_HYPERLINK_AREA, PARSE_TIMEOUT_MS, PARSE_HEAP_MB, MAX_EXTRACTED_CHARS,
  MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_UNCOMPRESSED_BYTES,
  HEAD_BYTES, truncationMarker, capText, matchesDeclaredOmType, isPlausibleOmUpload, classifyHead, inspectZip,
};
