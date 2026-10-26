'use strict';
// Broker OM intake hardening (audit 2026-10): real-bytes type check, server-side size cap, quarantine of
// rejected uploads, and bounded XLSX/DOCX extraction. These pin behaviour that did not exist on main.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const XLSX = require('xlsx');
const limits = require('../../netlify/functions/_shared/broker-limits.js');
const graphFiles = require('../../netlify/functions/_shared/graph-files.js');
const { extractDealTerms } = require('../../netlify/functions/_shared/broker-llm-extract.js');
const { signIntakeToken } = require('../../netlify/functions/_shared/validate.js');

const FN_DIR = path.join(__dirname, '..', '..', 'netlify', 'functions');
const load = (rel) => import(pathToFileURL(path.join(FN_DIR, rel)).href);

// ---------- helpers ----------
function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal zip writer. `declaredSize` lets a test LIE about the uncompressed size in the headers.
function buildZip(entries, { comment = Buffer.alloc(0) } = {}) {
  const locals = []; const centrals = []; let offset = 0; const offsets = [];
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = e.data;
    const comp = e.method === 0 ? raw : zlib.deflateRawSync(raw);
    const declared = e.declaredSize === undefined ? raw.length : e.declaredSize;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.method === 0 ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(declared, 22);
    const extra = e.extra || Buffer.alloc(0);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(extra.length, 28);
    const local = Buffer.concat([lh, name, extra, comp]);
    offsets.push(offset);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.centralStored || e.method === 0 ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.centralStored ? comp.length : declared, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30); ch.writeUInt32LE(e.reuseOffsetOf === undefined ? offset : offsets[e.reuseOffsetOf], 42);
    centrals.push(Buffer.concat([ch, name, extra]));
    if (e.reuseOffsetOf === undefined) { locals.push(local); offset += local.length; }
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt16LE(comment.length, 20);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

// Every real OOXML package has this part; extraction now requires it.
const CT = { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), method: 0 };

function xlsxBuffer(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const MARKER = /\[TRUNCATED:/;

// ---------- broker-limits ----------
test('matchesDeclaredOmType: real bytes must fit the declared extension', () => {
  const pdf = Buffer.from('%PDF-1.7');
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
  assert.equal(limits.matchesDeclaredOmType('pdf', pdf), true);
  assert.equal(limits.matchesDeclaredOmType('docx', zip), true);
  assert.equal(limits.matchesDeclaredOmType('xlsx', zip), true);
  assert.equal(limits.matchesDeclaredOmType('xls', ole), true);
  assert.equal(limits.matchesDeclaredOmType('doc', ole), true);
  assert.equal(limits.matchesDeclaredOmType('pdf', zip), false);
  assert.equal(limits.matchesDeclaredOmType('pdf', exe), false);
  assert.equal(limits.matchesDeclaredOmType('xlsx', pdf), false);
  assert.equal(limits.matchesDeclaredOmType('docx', ole), false);
  assert.equal(limits.matchesDeclaredOmType('docx', Buffer.alloc(0)), false);
  assert.equal(limits.matchesDeclaredOmType('exe', exe), false);
  assert.equal(limits.matchesDeclaredOmType('pdf', undefined), false);
});

test('capText: exact-cap text is untouched, one char over is cut with a visible marker, deterministically', () => {
  const at = 'a'.repeat(100);
  assert.deepEqual(limits.capText(at, 100), { text: at, truncated: false });
  const over = limits.capText(at + 'b', 100, 'too long');
  assert.equal(over.truncated, true);
  assert.ok(over.text.startsWith('a'.repeat(100)));
  assert.match(over.text, MARKER);
  assert.equal(limits.capText(at + 'b', 100, 'too long').text, over.text);
});

test('inspectZip accepts a well-formed archive (stored and deflated entries)', () => {
  const zip = buildZip([{ name: 'a.xml', data: Buffer.from('<a>hello</a>'.repeat(50)) }, { name: 'b.txt', data: Buffer.from('plain'), method: 0 }]);
  assert.deepEqual(limits.inspectZip(zip), { ok: true });
});

test('inspectZip rejects a header that understates a bomb (declared 10 bytes, inflates to 8 MB)', () => {
  const zip = buildZip([{ name: 'bomb.xml', data: Buffer.alloc(8 * 1024 * 1024), declaredSize: 10 }]);
  assert.ok(zip.length < 20_000, 'the bomb must be tiny on the wire');
  const r = limits.inspectZip(zip);
  assert.equal(r.ok, false);
});

test('inspectZip rejects declared sizes over the per-entry and total ceilings', () => {
  const entry = buildZip([{ name: 'x', data: Buffer.from('x'), declaredSize: limits.MAX_ZIP_ENTRY_BYTES + 1 }]);
  assert.equal(limits.inspectZip(entry).reason, 'zip_entry_too_large');
  const per = limits.MAX_ZIP_ENTRY_BYTES; // each entry is legal on its own; four of them are not
  const total = buildZip(['a', 'b', 'c', 'd'].map((name) => ({ name, data: Buffer.from('x'), declaredSize: per })));
  assert.equal(limits.inspectZip(total).reason, 'zip_too_large_uncompressed');
});

test('inspectZip rejects too many entries, truncated archives and non-zips', () => {
  const many = buildZip(Array.from({ length: limits.MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `p${i}`, data: Buffer.from('x'), method: 0 })));
  assert.equal(limits.inspectZip(many).reason, 'zip_too_many_entries');
  const ok = buildZip([{ name: 'a', data: Buffer.from('hello') }]);
  assert.equal(limits.inspectZip(ok.subarray(0, ok.length - 10)).ok, false);
  assert.equal(limits.inspectZip(Buffer.from('PK\x03\x04 not really a zip at all, just text')).ok, false);
});

test('inspectZip rejects a central directory that says STORED while the local header says deflate (SheetJS trusts the local one)', () => {
  const zip = buildZip([{ name: 'xl/media/pad.bin', data: Buffer.alloc(8 * 1024 * 1024), centralStored: true }]);
  assert.equal(limits.inspectZip(zip).reason, 'zip_inconsistent');
});

test('inspectZip rejects a second EOCD hidden inside the real comment (SheetJS scans from len-4), and any trailing comment', () => {
  const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(17)]);
  const data = Buffer.from('<a/>'.repeat(20));
  assert.equal(limits.inspectZip(buildZip([{ name: 'a.xml', data }], { comment: fake })).ok, false);
  assert.equal(limits.inspectZip(buildZip([{ name: 'a.xml', data }], { comment: Buffer.from('plain comment') })).ok, false);
});

test('inspectZip rejects an EOCD whose this-disk count (+8) differs from the total (+10): SheetJS reads more entries than are validated', () => {
  const zip = buildZip([{ name: 'a.xml', data: Buffer.from('<a>x</a>'.repeat(50)) }, { name: 'b.bin', data: Buffer.alloc(4 * 1024 * 1024), declaredSize: 10 }]);
  const eocd = zip.length - 22;
  zip.writeUInt16LE(2, eocd + 8);
  zip.writeUInt16LE(1, eocd + 10);
  assert.equal(limits.inspectZip(zip).ok, false);
  zip.writeUInt16LE(1, eocd + 8);
  zip.writeUInt16LE(2, eocd + 10);
  assert.equal(limits.inspectZip(zip).ok, false);
});

test('inspectZip rejects spare central records beyond the declared directory size', () => {
  const zip = buildZip([{ name: 'a.xml', data: Buffer.from('<a>x</a>'.repeat(50)) }, { name: 'b.bin', data: Buffer.alloc(4 * 1024 * 1024), declaredSize: 10 }]);
  const eocd = zip.length - 22;
  const cdSize = zip.readUInt32LE(eocd + 12);
  zip.writeUInt16LE(1, eocd + 8);
  zip.writeUInt16LE(1, eocd + 10);
  zip.writeUInt32LE(cdSize - 46 - 5, eocd + 12); // directory claims to hold only the first record
  assert.equal(limits.inspectZip(zip).ok, false);
});

function zip64Extra(usz) {
  const f = Buffer.alloc(20);
  f.writeUInt16LE(0x0001, 0); f.writeUInt16LE(16, 2); f.writeBigUInt64LE(BigInt(usz), 4); f.writeBigUInt64LE(5n, 12);
  return f;
}

test('inspectZip rejects a ZIP64 extra field (SheetJS takes the entry size from it and allocates it up front)', () => {
  const data = Buffer.from('<a>x</a>'.repeat(50));
  const zip = buildZip([{ name: 'xl/worksheets/sheet1.xml', data, extra: zip64Extra(500_000_000) }]);
  assert.equal(limits.inspectZip(zip).ok, false);
});

test('inspectZip accepts harmless extra fields (extended timestamp) and rejects a malformed extra block', () => {
  const data = Buffer.from('<a>x</a>'.repeat(50));
  const ts = Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(limits.inspectZip(buildZip([{ name: 'a.xml', data, extra: ts }])), { ok: true });
  const bad = Buffer.from([0x55, 0x54, 200, 0, 1]);
  assert.equal(limits.inspectZip(buildZip([{ name: 'a.xml', data, extra: bad }])).ok, false);
});

test('extractForScoring: the ZIP64-extra bomb workbook fails closed instead of allocating', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const data = Buffer.from('<a>x</a>'.repeat(50));
  const r = await extractForScoring(buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data, extra: zip64Extra(500_000_000) }]), 'xlsx');
  assert.equal(r.ok, false);
});

test('inspectZip: nested Index.zip, Numbers .iwa and ODF manifests are refused by name (SheetJS re-parses / quadratic decoder)', () => {
  const data = Buffer.from('<a>x</a>'.repeat(50));
  for (const name of ['Index.zip', 'deep/INDEX.ZIP', 'Index' + String.fromCharCode(92) + 'index.zip', 'Index/Document.iwa', 'x/Other.IWA', 'META-INF/manifest.xml']) {
    const r = limits.inspectZip(buildZip([CT, { name, data }]), { requireContentTypes: true });
    assert.equal(r.reason, 'zip_unsupported_content', name);
  }
});

test('inspectZip: [Content_Types].xml is required for OOXML extraction, and optional otherwise', () => {
  const data = Buffer.from('<a>x</a>'.repeat(50));
  assert.equal(limits.inspectZip(buildZip([{ name: 'a.xml', data }]), { requireContentTypes: true }).reason, 'zip_unsupported_content');
  assert.deepEqual(limits.inspectZip(buildZip([CT, { name: 'a.xml', data }]), { requireContentTypes: true }), { ok: true });
});

test('inspectZip: the local header name must equal the central name', () => {
  const zip = buildZip([CT, { name: 'xl/workbook.xml', data: Buffer.from('<a>x</a>'.repeat(50)) }]);
  // flip one byte of the SECOND entry's local name (find it after the first local record)
  const first = zip.indexOf(Buffer.from('xl/workbook.xml'));
  zip[first] = 0x58; // 'X' - local name now differs from the central directory's
  assert.equal(limits.inspectZip(zip).reason, 'zip_inconsistent');
});

test('extractForScoring: a nested Index.zip bomb workbook is refused before SheetJS re-parses it', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const inner = buildZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(4 * 1024 * 1024), declaredSize: 10 }]);
  const outer = buildZip([CT, { name: 'Index.zip', data: inner }]);
  assert.deepEqual(await extractForScoring(outer, 'xlsx'), { ok: false, reason: 'unparseable_file' });
});

test('inspectZip: SheetJS ODS dispatch names (objectdata.xml, index.xml) are refused even when [Content_Types].xml is present', async () => {
  const data = Buffer.from('<a>x</a>'.repeat(50));
  for (const name of ['objectdata.xml', 'sub/ObjectData.XML', 'index.xml', 'Index.xml.gz']) {
    assert.equal(limits.inspectZip(buildZip([CT, { name, data }]), { requireContentTypes: true }).reason, 'zip_unsupported_content', name);
  }
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const ods = buildZip([CT, { name: 'objectdata.xml', data }, { name: 'content.xml', data }]);
  assert.deepEqual(await extractForScoring(ods, 'xlsx'), { ok: false, reason: 'unparseable_file' });
});

test('extractForScoring: a sheet declaring a huge dimension is clamped to MAX_COLS_PER_SHEET columns, quickly, with a marker', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const wb = XLSX.utils.book_new();
  const ws = { A1: { t: 's', v: 'Header text content' }, B1: { t: 's', v: 'Rent' }, XFD2000: { t: 's', v: 'far-corner-value' }, '!ref': 'A1:XFD2000' };
  XLSX.utils.book_append_sheet(wb, ws, 'Wide');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const t0 = Date.now();
  const r = await extractForScoring(buf, 'xlsx');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.match(r.text, /Header text content/);
  assert.match(r.text, new RegExp(`cut at ${limits.MAX_COLS_PER_SHEET} columns`));
  assert.doesNotMatch(r.text, /far-corner-value/);
});

test('extractForScoring: an oversized docx XML part (mammoth DOM is ~100x its size) fails closed', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const xml = Buffer.from('<w:p><w:r><w:t>text</w:t></w:r></w:p>'.repeat(Math.ceil((limits.MAX_DOCX_XML_BYTES + 100) / 30)));
  assert.ok(xml.length > limits.MAX_DOCX_XML_BYTES);
  const r = await extractForScoring(buildZip([CT, { name: 'word/document.xml', data: xml }]), 'docx');
  assert.deepEqual(r, { ok: false, reason: 'archive_too_large' });
});

const sheetWithLink = (ref) => Buffer.from(`<worksheet><hyperlinks><hyperlink ref="${ref}" location="S0!A1"/></hyperlinks></worksheet>`);

test('inspectZip: a worksheet hyperlink spanning a whole sheet is refused (SheetJS creates a cell per address); in-window links pass', () => {
  const opts = { requireContentTypes: true };
  for (const ref of ['A1:XFD1048576', 'A1:CV100000', 'A1:A1048576']) {
    assert.equal(limits.inspectZip(buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data: sheetWithLink(ref) }]), opts).reason, 'zip_unsupported_content', ref);
  }
  for (const ref of ['A1', 'B2:D40', 'A1:IV2000']) {
    assert.deepEqual(limits.inspectZip(buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data: sheetWithLink(ref) }]), opts), { ok: true }, ref);
  }
});

test('extractForScoring: the hyperlink-range bomb workbook fails closed without parsing', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const t0 = Date.now();
  const r = await extractForScoring(buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data: sheetWithLink('A1:XFD1048576') }]), 'xlsx');
  assert.deepEqual(r, { ok: false, reason: 'unparseable_file' });
  assert.ok(Date.now() - t0 < 2000);
});

test('inspectZip: xlsb parts are refused for OOXML extraction', () => {
  for (const name of ['xl/workbook.bin', 'xl/worksheets/sheet1.bin']) {
    assert.equal(limits.inspectZip(buildZip([CT, { name, data: Buffer.from('xxxxxxxx') }]), { requireContentTypes: true }).reason, 'zip_unsupported_content', name);
  }
});

test('extractForScoring: docx XML parts that are each under the cap but sum past the total cap fail closed', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const part = Buffer.from('<w:p><w:r><w:t>text</w:t></w:r></w:p>'.repeat(Math.floor((2.5 * 1024 * 1024) / 37)));
  assert.ok(part.length < limits.MAX_DOCX_XML_BYTES);
  const r = await extractForScoring(buildZip([CT, { name: 'word/document.xml', data: part }, { name: 'word/footnotes.xml', data: part }, { name: 'word/comments.xml', data: part }]), 'docx');
  assert.deepEqual(r, { ok: false, reason: 'archive_too_large' });
});

test('extractForScoring: a legacy .xls whose HLink record spans the whole sheet is refused quickly; an in-window link is not', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const mk = (patch) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Address', 'Rent'], ['1 Main St', 1000]]);
    ws.A2.l = { Target: 'https://example.com/x' };
    XLSX.utils.book_append_sheet(wb, ws, 'RR');
    const cfb = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xls' }), { type: 'buffer' });
    const stream = XLSX.CFB.find(cfb, 'Workbook') || XLSX.CFB.find(cfb, 'Book');
    const b = Buffer.from(stream.content);
    let pos = 0; let patched = 0;
    while (pos + 4 <= b.length) {
      const id = b.readUInt16LE(pos); const size = b.readUInt16LE(pos + 2);
      if (id === 0x01b8 && patch) { b.writeUInt16LE(patch.rows, pos + 6); b.writeUInt16LE(patch.cols, pos + 10); patched += 1; }
      pos += 4 + size;
    }
    stream.content = b;
    return { buf: Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' })), patched };
  };
  const bomb = mk({ rows: 65535, cols: 255 });
  assert.ok(bomb.patched >= 1, 'fixture must contain an HLink record');
  const t0 = Date.now();
  assert.deepEqual(await extractForScoring(bomb.buf, 'xls'), { ok: false, reason: 'archive_too_large' });
  assert.ok(Date.now() - t0 < 3000);
  const fine = mk({ rows: 5, cols: 3 });
  const ok = await extractForScoring(fine.buf, 'xls');
  assert.equal(ok.ok, true);
});

// ---------- isolated parse ----------
// Many links that are each inside the window but together cover 30M cells (the shape that aborted a worker thread).
const manyLinks = (prefix) => Array.from({ length: 60 }, (_, i) => `A${i * 2000 + 1}:IV${i * 2000 + 2000}`).map((r) => (prefix ? r : r));
// A minimal but complete xlsx whose sheet declares a hyperlink in a spelling the pre-scan does not recognise
// (namespace prefix + single quotes), i.e. exactly what the review rounds kept finding.
function linkBombXlsx(ref) {
  const NS = 'http://schemas.openxmlformats.org/';
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0"?><Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0"?><workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`<?xml version="1.0"?><worksheet xmlns="${NS}spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header text content here</t></is></c></row></sheetData><hyperlinks>${[].concat(ref).map((r) => `<x:hyperlink ref='${r}' location='S!A1'/>`).join('')}</hyperlinks></worksheet>`) },
  ]);
}

test('isolation: a hyperlink bomb the pre-scan misses is stopped by the child-process time limit, and the next extraction still works', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const bomb = linkBombXlsx('A1:CV100000');
  assert.deepEqual(limits.inspectZip(bomb, { requireContentTypes: true }), { ok: true }, 'fixture must slip past the byte-level checks');
  const t0 = Date.now();
  const r = await extractForScoring(bomb, 'xlsx', { parseTimeoutMs: 3500 });
  assert.equal(r.ok, false);
  assert.ok(['extraction_timeout', 'extraction_resource_limit'].includes(r.reason), r.reason);
  assert.ok(Date.now() - t0 < 12000, `took ${Date.now() - t0} ms`);
  const next = await extractForScoring(xlsxBuffer([['Rent Roll', [['Unit', 'Rent'], ['1', 1000]]]]), 'xlsx');
  assert.equal(next.ok, true);
});

test('the hyperlink pre-scan is linear: an unterminated "<hyperlink " flood cannot stall the caller (was 91 s at 1.6 MB)', () => {
  for (const unit of ['<hyperlink ', '<hyperlink ref="A1" ', '<hyperlink x ']) {
    const data = Buffer.from(unit.repeat(Math.ceil((4 * 1024 * 1024) / unit.length)));
    const zip = buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data }]);
    const t0 = Date.now();
    assert.deepEqual(limits.inspectZip(zip, { requireContentTypes: true }), { ok: true });
    assert.ok(Date.now() - t0 < 1500, `${unit}: ${Date.now() - t0} ms`);
  }
});

test('the hyperlink pre-scan stays linear on tags stuffed with repeated "<hyperlink" starts (was quadratic per tag: 25 s at 336 KB)', () => {
  const tag = '<hyperlink'.repeat(409) + '>';
  const part = Buffer.from(tag.repeat(Math.ceil((12 * 1024 * 1024) / tag.length)));
  const zip = buildZip([CT, ...[1, 2, 3].map((n) => ({ name: `xl/worksheets/sheet${n}.xml`, data: part }))]);
  const t0 = Date.now();
  assert.deepEqual(limits.inspectZip(zip, { requireContentTypes: true }), { ok: true });
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
});

test('summed hyperlink areas count: 60 in-window links that together cover 30M cells are refused by the pre-scan', () => {
  const NS = 'http://schemas.openxmlformats.org/';
  const links = manyLinks().map((r) => `<hyperlink ref="${r}" location="S!A1"/>`).join('');
  const zip = buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`<worksheet xmlns="${NS}spreadsheetml/2006/main"><hyperlinks>${links}</hyperlinks></worksheet>`) }]);
  assert.equal(limits.inspectZip(zip, { requireContentTypes: true }).reason, 'zip_unsupported_content');
});

test('isolation: a fatal V8 heap abort inside the parse kills only the child; the caller survives and reports a resource-limit reason', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const bomb = linkBombXlsx(manyLinks()); // x: spelling slips past the pre-scan
  assert.deepEqual(limits.inspectZip(bomb, { requireContentTypes: true }), { ok: true });
  const r = await extractForScoring(bomb, 'xlsx', { heapMb: 64, parseTimeoutMs: 30000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'extraction_resource_limit');
  const next = await extractForScoring(xlsxBuffer([['Rent Roll', [['Unit', 'Rent'], ['1', 1000]]]]), 'xlsx');
  assert.equal(next.ok, true);
});

test('isolation: a parse that exhausts the child heap is contained (resource-limit reason), not an OOM of the caller', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const r = await extractForScoring(linkBombXlsx('A1:CV30000'), 'xlsx', { heapMb: 48, parseTimeoutMs: 20000 });
  assert.equal(r.ok, false);
  assert.ok(['extraction_resource_limit', 'extraction_timeout'].includes(r.reason), r.reason);
});

function pidGone(pid, withinMs = 4000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      try { process.kill(pid, 0); } catch { resolve(true); return; }
      if (Date.now() - t0 > withinMs) { resolve(false); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

test('isolation: if the child cannot start, extraction FAILS CLOSED (extraction_unavailable) and never parses in-process', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const buf = xlsxBuffer([['Rent Roll', [['Unit', 'Rent'], ['1', 1000]]]]);
  const r = await extractForScoring(buf, 'xlsx', { workerPath: path.join(FN_DIR, 'does-not-exist.mjs') });
  assert.deepEqual(r, { ok: false, reason: 'extraction_unavailable' });
});

test('isolation: a child that never says ready is killed at the timeout and reported extraction_unavailable (no in-process parse, no hang)', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const fs = require('node:fs');
  const os = require('node:os');
  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'om-stub-')), 'silent.mjs');
  fs.writeFileSync(stub, 'setInterval(() => {}, 1000);\n');
  let pid;
  const t0 = Date.now();
  const r = await extractForScoring(xlsxBuffer([['Rent Roll', [['Unit', 'Rent'], ['1', 1000]]]]), 'xlsx', { workerPath: stub, parseTimeoutMs: 800, onSpawn: (c) => { pid = c.pid; } });
  assert.deepEqual(r, { ok: false, reason: 'extraction_unavailable' });
  assert.ok(Date.now() - t0 < 5000, 'must return promptly at the timeout, not hang');
  assert.ok(pid, 'child was spawned');
  assert.equal(await pidGone(pid), true, 'the silent child must be killed');
});

test('isolation: the child process is gone after a timeout kill', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  let pid;
  const r = await extractForScoring(linkBombXlsx('A1:CV100000'), 'xlsx', { parseTimeoutMs: 3500, onSpawn: (c) => { pid = c.pid; } });
  assert.equal(r.ok, false);
  assert.ok(['extraction_timeout', 'extraction_resource_limit'].includes(r.reason), r.reason); // whichever ceiling the child hits first
  assert.ok(pid);
  assert.equal(await pidGone(pid), true, 'child pid ' + pid + ' still alive after the timeout');
});

test('isolation: the child environment carries only PATH and OM_PARSE_CHILD (no secrets)', async () => {
  const { childEnv } = await load('_shared/broker-extraction.mjs');
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'must-not-leak';
  try {
    const env = childEnv();
    assert.deepEqual(Object.keys(env).sort(), ['OM_PARSE_CHILD', 'PATH']);
    assert.equal(env.OM_PARSE_CHILD, '1');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('isolation: legitimate files give identical results with and without the child process', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const buf = xlsxBuffer([['A', [['Address', 'Rent'], ['1 Main St', 1000]]], ['B', [['x', 'y'], [1, 2]]]]);
  assert.deepEqual(await extractForScoring(buf, 'xlsx'), await extractForScoring(buf, 'xlsx', { isolate: false }));
});

test('inspectZip rejects overlapping entries (one payload counted by many central-directory records)', () => {
  const entries = [{ name: 'a.xml', data: Buffer.from('<a>x</a>'.repeat(100)) }];
  for (let i = 0; i < 50; i += 1) entries.push({ name: 'a.xml', data: Buffer.from('<a>x</a>'.repeat(100)), reuseOffsetOf: 0 });
  assert.equal(limits.inspectZip(buildZip(entries)).reason, 'zip_overlap');
});

test('inspectZip accepts a data-descriptor style entry (local sizes zero, flag bit 3)', () => {
  const zip = buildZip([{ name: 'a.xml', data: Buffer.from('<a>hello</a>'.repeat(40)) }]);
  zip.writeUInt16LE(0x8, 6);
  zip.writeUInt32LE(0, 18);
  zip.writeUInt32LE(0, 22);
  assert.deepEqual(limits.inspectZip(zip), { ok: true });
});

test('inspectZip exactly at the entry-count ceiling is accepted (boundary)', () => {
  const at = buildZip(Array.from({ length: limits.MAX_ZIP_ENTRIES }, (_, i) => ({ name: `p${i}`, data: Buffer.from('x'), method: 0 })));
  assert.deepEqual(limits.inspectZip(at), { ok: true });
});

// ---------- extractForScoring ----------
test('extractForScoring: a PDF named .xlsx is a file_type_mismatch and is never parsed', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const r = await extractForScoring(Buffer.from('%PDF-1.7 pretending to be a workbook'), 'xlsx');
  assert.deepEqual(r, { ok: false, reason: 'file_type_mismatch' });
});

test('extractForScoring: an executable named .pdf is a file_type_mismatch (never base64-ed to the LLM)', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const r = await extractForScoring(Buffer.from('MZ\x90\x00 totally a pdf'), 'pdf');
  assert.deepEqual(r, { ok: false, reason: 'file_type_mismatch' });
});

test('extractForScoring: a zip bomb as xlsx fails closed before SheetJS touches it', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const bomb = buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(8 * 1024 * 1024), declaredSize: 10 }]);
  const r = await extractForScoring(bomb, 'xlsx');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'archive_too_large');
});

test('extractForScoring: a zip declaring a huge uncompressed total as docx fails closed', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const bomb = buildZip([CT, { name: 'word/document.xml', data: Buffer.from('x'), declaredSize: limits.MAX_ZIP_ENTRY_BYTES + 1 }]);
  assert.deepEqual(await extractForScoring(bomb, 'docx'), { ok: false, reason: 'archive_too_large' });
});

test('extractForScoring: sheet cap - 30 sheets yields the first MAX_EXTRACTED_SHEETS plus a visible marker', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const sheets = Array.from({ length: limits.MAX_EXTRACTED_SHEETS + 5 }, (_, i) => [`S${i + 1}`, [['Address', 'Rent'], [`${i} Main St`, 1000 + i]]]);
  const r = await extractForScoring(xlsxBuffer(sheets), 'xlsx');
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.match(r.text, /Sheet: S25\n/);
  assert.doesNotMatch(r.text, /Sheet: S26\n/);
  assert.match(r.text, MARKER);
  assert.match(r.text, /5 of 30 sheets omitted/);
});

test('extractForScoring: exactly MAX_EXTRACTED_SHEETS sheets is NOT truncated (boundary)', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const sheets = Array.from({ length: limits.MAX_EXTRACTED_SHEETS }, (_, i) => [`S${i + 1}`, [['Address', 'Rent'], [`${i} Main St`, 1000 + i]]]);
  const r = await extractForScoring(xlsxBuffer(sheets), 'xlsx');
  assert.equal(r.ok, true);
  assert.equal(r.truncated, false);
  assert.doesNotMatch(r.text, MARKER);
});

test('extractForScoring: row cap boundary - exactly MAX_ROWS_PER_SHEET rows is whole, one more is cut with a marker', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const rows = (n) => Array.from({ length: n }, (_, i) => [`Unit ${i + 1}`, i + 1]);
  const whole = await extractForScoring(xlsxBuffer([['Rent Roll', rows(limits.MAX_ROWS_PER_SHEET)]]), 'xlsx');
  assert.equal(whole.ok, true);
  assert.equal(whole.truncated, false);
  assert.match(whole.text, new RegExp(`Unit ${limits.MAX_ROWS_PER_SHEET},`));
  const cut = await extractForScoring(xlsxBuffer([['Rent Roll', rows(limits.MAX_ROWS_PER_SHEET + 1)]]), 'xlsx');
  assert.equal(cut.ok, true);
  assert.equal(cut.truncated, true);
  assert.match(cut.text, MARKER);
  assert.match(cut.text, new RegExp(`Unit ${limits.MAX_ROWS_PER_SHEET},`));
  assert.doesNotMatch(cut.text, new RegExp(`Unit ${limits.MAX_ROWS_PER_SHEET + 1},`));
  assert.match(cut.text, /cut at 2000 rows/);
});

test('extractForScoring: character cap - over-cap workbook text is cut deterministically with a marker', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const fat = 'x'.repeat(30_000);
  const buf = xlsxBuffer([['Big', Array.from({ length: 20 }, (_, i) => [`row${i}`, fat])]]);
  const a = await extractForScoring(buf, 'xlsx');
  const b = await extractForScoring(buf, 'xlsx');
  assert.equal(a.ok, true);
  assert.equal(a.truncated, true);
  assert.ok(a.text.length < limits.MAX_EXTRACTED_CHARS + 500, `text ${a.text.length} must stay near the cap`);
  assert.match(a.text, MARKER);
  assert.equal(a.text, b.text, 'same input, same output');
});

test('extractForScoring: a sheet landing just under the cap with more sheets behind it is still marked truncated', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  // Sheet A's CSV part is exactly MAX - 10 chars (header 'Sheet: A' + newline, 6 full rows, newlines, one short row).
  const full = 'n'.repeat(30_000);
  const tail = 'n'.repeat(limits.MAX_EXTRACTED_CHARS - 10 - 9 - 6 * 30_000 - 6);
  const r = await extractForScoring(xlsxBuffer([['A', [[full], [full], [full], [full], [full], [full], [tail]]], ['B', [['second sheet content here']]]]), 'xlsx');
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.match(r.text, MARKER);
  assert.doesNotMatch(r.text, /second sheet content/);
});

test('extractForScoring: multi-line cells are not counted as extra rows, and the omitted-sheets note survives the char cap', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const nl = String.fromCharCode(10);
  const rows = Array.from({ length: 1500 }, (_, i) => [`Tenant ${i}`, 'line one' + nl + 'line two' + nl + 'line three']);
  const r = await extractForScoring(xlsxBuffer([['Rent Roll', rows]]), 'xlsx');
  assert.equal(r.ok, true);
  assert.match(r.text, /Tenant 1499/, 'all 1500 real rows kept');
  assert.doesNotMatch(r.text, /cut at/);
  const fat = 'w'.repeat(30_000);
  const many = Array.from({ length: 6 }, (_, i) => [`F${i}`, [[fat], [fat]]]);
  const c = await extractForScoring(xlsxBuffer(many), 'xlsx');
  assert.match(c.text, /further sheets omitted/);
});

test('extractForScoring: all sheets together are capped (many mid-size sheets cannot sum past the cap)', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const fat = 'y'.repeat(20_000);
  const sheets = Array.from({ length: 20 }, (_, i) => [`T${i + 1}`, Array.from({ length: 5 }, (_, r) => [`r${r}`, fat])]);
  const r = await extractForScoring(xlsxBuffer(sheets), 'xlsx');
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < limits.MAX_EXTRACTED_CHARS + 500);
});

test('extractForScoring: docx text over the character cap is cut with a marker; under it is untouched', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const docx = (text) => buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) },
  ]);
  const small = await extractForScoring(docx('Offering memorandum for 123 Main Street, asking price 2,000,000'), 'docx');
  assert.equal(small.ok, true);
  assert.equal(small.truncated, false);
  assert.doesNotMatch(small.text, MARKER);
  const big = await extractForScoring(docx('z'.repeat(limits.MAX_EXTRACTED_CHARS + 5000)), 'docx');
  assert.equal(big.ok, true);
  assert.equal(big.truncated, true);
  assert.match(big.text, MARKER);
  assert.ok(big.text.length < limits.MAX_EXTRACTED_CHARS + 500);
});

test('extractForScoring: over the byte ceiling is refused before any inspection', async () => {
  const { extractForScoring } = await load('_shared/broker-extraction.mjs');
  const r = await extractForScoring(Buffer.alloc(limits.MAX_SCORING_BYTES + 1, 0x50), 'xlsx');
  assert.deepEqual(r, { ok: false, reason: 'file_too_large_for_scoring' });
});

// ---------- LLM prompt backstop ----------
test('extractDealTerms never sends text over the cap: an over-cap string is cut with a marker before the API call', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: 'record_deal_terms', input: {} }] }) };
  };
  await extractDealTerms({ kind: 'text', text: 'q'.repeat(limits.MAX_EXTRACTED_CHARS * 3) }, { fetchImpl });
  const prompt = sent.messages[0].content[0].text;
  assert.ok(prompt.length < limits.MAX_EXTRACTED_CHARS + 2000, `prompt ${prompt.length} chars`);
  assert.match(prompt, MARKER);
});

// ---------- graph-files ----------
const GRAPH_ENV = { GRAPH_DRIVE_ID: 'drive-1' };
function withGraphEnv(fn) {
  const prev = process.env.GRAPH_DRIVE_ID; process.env.GRAPH_DRIVE_ID = GRAPH_ENV.GRAPH_DRIVE_ID;
  return Promise.resolve(fn()).finally(() => { if (prev === undefined) delete process.env.GRAPH_DRIVE_ID; else process.env.GRAPH_DRIVE_ID = prev; });
}
function streamOf(chunks) {
  let i = 0; let cancelled = false;
  return {
    cancelled: () => cancelled,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => { cancelled = true; } }) },
  };
}

test('getFileHead asks for a byte range and never buffers more than it needs, even if the server ignores Range', () => withGraphEnv(async () => {
  const s = streamOf([Buffer.from('%PDF-1.7'), Buffer.alloc(5_000_000)]);
  let range;
  const fetchImpl = async (url, opts) => { range = opts.headers.range; return { ok: true, status: 200, body: s.body }; };
  const head = await graphFiles.getFileHead('Broker Submissions/x/om.pdf', 8, { fetchImpl, token: 't' });
  assert.equal(range, 'bytes=0-7');
  assert.equal(head.toString(), '%PDF-1.7');
  assert.equal(s.cancelled(), true, 'the rest of the stream must be cancelled');
}));

test('getFileHead returns null on 404 and throws on other failures', () => withGraphEnv(async () => {
  assert.equal(await graphFiles.getFileHead('Broker Submissions/x/a.pdf', 8, { fetchImpl: async () => ({ ok: false, status: 404 }), token: 't' }), null);
  await assert.rejects(graphFiles.getFileHead('Broker Submissions/x/a.pdf', 8, { fetchImpl: async () => ({ ok: false, status: 500 }), token: 't' }), /500/);
}));

test('getFileContent with maxBytes: Content-Length over the cap is refused without reading the body', () => withGraphEnv(async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => '999999999' }, arrayBuffer: async () => { throw new Error('must not read'); } });
  await assert.rejects(graphFiles.getFileContent('Broker Submissions/x/a.pdf', { fetchImpl, token: 't', maxBytes: 1000 }), (e) => e.code === 'too_large');
}));

test('getFileContent with maxBytes: a stream that outgrows the cap is aborted (boundary: exactly the cap is fine)', () => withGraphEnv(async () => {
  const over = streamOf([Buffer.alloc(600), Buffer.alloc(600)]);
  await assert.rejects(graphFiles.getFileContent('Broker Submissions/x/a.pdf', { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: over.body }), token: 't', maxBytes: 1000 }), (e) => e.code === 'too_large');
  assert.equal(over.cancelled(), true);
  const exact = streamOf([Buffer.alloc(500), Buffer.alloc(500)]);
  const buf = await graphFiles.getFileContent('Broker Submissions/x/a.pdf', { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: exact.body }), token: 't', maxBytes: 1000 });
  assert.equal(buf.length, 1000);
}));

test('quarantineUpload MOVES (PATCH) one broker upload into _Quarantine with a collision-safe rename, never deletes', () => withGraphEnv(async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if ((opts.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ id: 'qfolder-id' }) }; // folders exist
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const p = 'Broker Submissions/2026-10-18_Acme-0_ab12cd34/om.pdf';
  const r = await graphFiles.quarantineUpload(p, { fetchImpl, token: 't' });
  assert.equal(r.path, 'Broker Submissions/_Quarantine/2026-10-18_Acme-0_ab12cd34__om.pdf');
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'never a delete');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.includes(encodeURI('Broker Submissions/2026-10-18_Acme-0_ab12cd34/om.pdf')));
  const body = JSON.parse(patch.body);
  assert.deepEqual(body.parentReference, { id: 'qfolder-id' });
  assert.match(patch.url, /[?]@microsoft[.]graph[.]conflictBehavior=rename$/);
}));

test('quarantineUpload refuses anything that is not one of this flow\'s own uploads', () => withGraphEnv(async () => {
  const fetchImpl = async () => { throw new Error('must not touch the network'); };
  for (const bad of [
    'Deals/Confidential/psa.pdf',
    'Broker Submissions/_Quarantine/2026-10-18_Acme_ab12cd34__om.pdf',
    'Broker Submissions/2026-10-18_Acme_ab12cd34/sub/om.pdf',
    'Broker Submissions/../Deals/om.pdf',
    'Broker Submissions/2026-10-18_Acme_ab12cd34',
    '',
  ]) {
    await assert.rejects(graphFiles.quarantineUpload(bad, { fetchImpl, token: 't' }), /refused/, bad);
  }
}));

// ---------- broker-finalize ----------
const ENV = { INTAKE_TOKEN_SECRET: 'intake-secret', GRAPH_DRIVE_ID: 'drive-1', URL: 'https://oxfordra.net', GRAPH_SEND_FROM: 'no-reply@oxfordra.net', GRAPH_TENANT_ID: 'tenant-1', GRAPH_CLIENT_ID: 'client-1', GRAPH_CLIENT_SECRET: 'secret-1' };
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

async function finalize({ itemPath, claimedSize, itemSize, head, headThrows, quarantineThrows }) {
  const { handleBrokerFinalize } = await load('broker-finalize.mjs');
  const token = signIntakeToken({ type: 'upload', path: itemPath, size: claimedSize, exp: Date.now() + 60_000 }, 'intake-secret');
  const req = new Request('https://oxfordra.net/api/broker-finalize', { method: 'POST', body: JSON.stringify({ intakeToken: token, name: 'Bob', company: 'Acme', email: 'b@acme.com' }) });
  const net = [];
  const quarantined = [];
  let consumed = 0;
  const fetchImpl = async (url, opts = {}) => {
    net.push(url);
    if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('/root:/')) return { ok: true, status: 200, json: async () => ({ id: 'i', size: itemSize, webUrl: 'https://x' }) };
    return { ok: true, status: 200 };
  };
  const res = await handleBrokerFinalize(req, {
    fetchImpl,
    getFileHeadImpl: async () => { if (headThrows) throw new Error('graph down'); return head; },
    quarantineUploadImpl: async (p) => { if (quarantineThrows) throw new Error('move failed'); quarantined.push(p); return { path: 'q' }; },
    consumeIntakeTokenImpl: async () => { consumed += 1; return { first: true }; },
    releaseIntakeTokenImpl: async () => {},
    checkAndRecordRateLimitImpl: async () => ({ allowed: false }),
    checkAndRecordDailyCapImpl: async () => ({ allowed: false }),
  });
  return { status: res.status, body: JSON.parse(await res.text()), net, quarantined, consumed };
}
const PDF = Buffer.from('%PDF-1.7\n');
const P = 'Broker Submissions/2026-10-18_Acme_ab12cd34/om.pdf';
const sideEffects = (net) => net.filter((u) => u === 'https://oxfordra.net/' || u.includes('sendMail'));

test('finalize: an upload over the server-side size cap is rejected 413, quarantined, and has no side effects', () => withEnv(ENV, async () => {
  const size = limits.MAX_UPLOAD_BYTES + 1;
  const r = await finalize({ itemPath: P, claimedSize: size, itemSize: size, head: PDF });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'file_too_large');
  assert.deepEqual(r.quarantined, [P]);
  assert.equal(r.consumed, 0, 'the intake token is not burned for a rejected file');
  assert.deepEqual(sideEffects(r.net), [], 'no ledger row, no email');
}));

test('finalize: exactly the size cap is accepted (boundary)', () => withEnv(ENV, async () => {
  const r = await finalize({ itemPath: P, claimedSize: limits.MAX_UPLOAD_BYTES, itemSize: limits.MAX_UPLOAD_BYTES, head: PDF });
  assert.equal(r.status, 200);
  assert.deepEqual(r.quarantined, []);
}));

test('finalize: an executable renamed to .pdf is rejected 422 file_content_mismatch and quarantined', () => withEnv(ENV, async () => {
  const r = await finalize({ itemPath: P, claimedSize: 5000, itemSize: 5000, head: Buffer.from('MZ\x90\x00\x03\x00\x00\x00') });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'file_content_mismatch');
  assert.deepEqual(r.quarantined, [P]);
  assert.deepEqual(sideEffects(r.net), []);
}));

test('finalize: a ZIP renamed to .pdf, and a PDF renamed to .xlsx, are both mismatches', () => withEnv(ENV, async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.equal((await finalize({ itemPath: P, claimedSize: 5000, itemSize: 5000, head: zip })).body.error, 'file_content_mismatch');
  const x = 'Broker Submissions/2026-10-18_Acme_ab12cd34/rent-roll.xlsx';
  assert.equal((await finalize({ itemPath: x, claimedSize: 5000, itemSize: 5000, head: PDF })).body.error, 'file_content_mismatch');
}));

test('finalize stays lenient for real-world leads: encrypted OOXML (OLE2) as .docx/.xlsx, RTF as .doc, HTML as .xls all finalize', () => withEnv(ENV, async () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const rtf = Buffer.from('{' + String.fromCharCode(92) + 'rtf1');
  for (const [file, head] of [['locked.docx', ole], ['locked.xlsx', ole], ['memo.doc', rtf], ['rr.xls', Buffer.from('<html><body><table>')]]) {
    const r = await finalize({ itemPath: `Broker Submissions/2026-10-18_Acme_ab12cd34/${file}`, claimedSize: 5000, itemSize: 5000, head });
    assert.equal(r.status, 200, file);
    assert.deepEqual(r.quarantined, [], file);
  }
}));

test('finalize still refuses hostile signatures under any allowed extension (exe, ELF, script, Mach-O/class)', () => withEnv(ENV, async () => {
  for (const head of [Buffer.from('MZ'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('#!/bin/sh'), Buffer.from([0xca, 0xfe, 0xba, 0xbe])]) {
    for (const file of ['a.pdf', 'a.docx', 'a.xlsx', 'a.xls', 'a.doc']) {
      const r = await finalize({ itemPath: `Broker Submissions/2026-10-18_Acme_ab12cd34/${file}`, claimedSize: 5000, itemSize: 5000, head });
      assert.equal(r.body.error, 'file_content_mismatch', `${file} ${head.toString('hex')}`);
    }
  }
}));

test('finalize: an extension outside the allow-list is rejected before any byte is read', () => withEnv(ENV, async () => {
  const r = await finalize({ itemPath: 'Broker Submissions/2026-10-18_Acme_ab12cd34/run.exe', claimedSize: 5000, itemSize: 5000, head: PDF });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'file_type_rejected');
  assert.equal(r.quarantined.length, 1);
}));

test('finalize: a Graph failure reading the head is fail-closed but retryable (502, nothing quarantined, token unburned)', () => withEnv(ENV, async () => {
  const r = await finalize({ itemPath: P, claimedSize: 5000, itemSize: 5000, headThrows: true });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'type_check_unavailable');
  assert.deepEqual(r.quarantined, []);
  assert.equal(r.consumed, 0);
  assert.deepEqual(sideEffects(r.net), []);
}));

test('finalize: a failing quarantine move does not change the rejection (file stays, broker still gets 422)', () => withEnv(ENV, async () => {
  const r = await finalize({ itemPath: P, claimedSize: 5000, itemSize: 5000, head: Buffer.from('MZ'), quarantineThrows: true });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'file_content_mismatch');
  assert.deepEqual(sideEffects(r.net), []);
}));

test('finalize: a rejected upload never writes a Forms row, however often the token is replayed', () => withEnv(ENV, async () => {
  for (let i = 0; i < 4; i += 1) {
    const r = await finalize({ itemPath: P, claimedSize: 5000, itemSize: 5000, head: Buffer.from('MZ') });
    assert.equal(r.status, 422);
    assert.deepEqual(r.net.filter((u) => u === 'https://oxfordra.net/'), []);
  }
}));

test('finalize: a valid PDF, DOCX and XLSX within limits still finalize (200) with no quarantine', () => withEnv(ENV, async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  for (const [file, head] of [['om.pdf', PDF], ['memo.docx', zip], ['rent-roll.xlsx', zip]]) {
    const r = await finalize({ itemPath: `Broker Submissions/2026-10-18_Acme_ab12cd34/${file}`, claimedSize: 40_000_000, itemSize: 40_000_000, head });
    assert.equal(r.status, 200, file);
    assert.deepEqual(r.quarantined, [], file);
  }
}));

// ---------- Office size drift (SharePoint rewrites Office files after upload) ----------
test('uploadSizeAcceptable: exact match always; Office types tolerate bounded drift; PDFs and wild drift do not', () => {
  const ok = limits.uploadSizeAcceptable;
  assert.equal(ok('pdf', 5000, 5000), true);
  assert.equal(ok('pdf', 5000, 5001), false, 'PDFs are stored verbatim');
  for (const ext of ['docx', 'xlsx', 'xls', 'doc']) {
    assert.equal(ok(ext, 8993, 8993), true);
    assert.equal(ok(ext, 8993, 12000), true, ext + ' drift within tolerance');
    assert.equal(ok(ext, 8993, 8993 + 1048576), true, 'exactly at the tolerance');
    assert.equal(ok(ext, 8993, 8993 + 1048576 + 1), false, 'one byte past the tolerance');
    assert.equal(ok(ext, 8993, 0), false, 'empty stored file');
  }
  assert.equal(ok('xlsx', 20_000_000, 24_900_000), true, 'ratio tolerance scales with large files');
  assert.equal(ok('xlsx', 20_000_000, 25_100_000), false);
  assert.equal(ok('xlsx', 5000, undefined), true, 'missing size is judged by later checks, as before');
  const MB = 1024 * 1024;
  assert.equal(ok('xlsx', 8 * MB, 6 * MB), true, 'shrink exactly at the 25% tolerance');
  assert.equal(ok('xlsx', 8 * MB, 6 * MB - 1), false, 'shrink one byte past the tolerance');
});

test('finalize: an xlsx whose stored size drifted (SharePoint rewrite) still finalizes, an out-of-tolerance one is 409', () => withEnv(ENV, async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const x = 'Broker Submissions/2026-10-23_Acme_ab12cd34/rent-roll.xlsx';
  const drifted = await finalize({ itemPath: x, claimedSize: 8993, itemSize: 9407, head: zip });
  assert.equal(drifted.status, 200);
  assert.deepEqual(drifted.quarantined, []);
  const far = await finalize({ itemPath: x, claimedSize: 8993, itemSize: 8993 + 5 * 1024 * 1024, head: zip });
  assert.equal(far.status, 409);
  assert.equal(far.body.error, 'size_mismatch');
}));

test('finalize: an upper-case .XLSX path with a drifted size still finalizes (extension match is case-insensitive)', () => withEnv(ENV, async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const r = await finalize({ itemPath: 'Broker Submissions/2026-10-23_Acme_ab12cd34/rent-roll.XLSX', claimedSize: 8993, itemSize: 9407, head: zip });
  assert.equal(r.status, 200);
  assert.deepEqual(r.quarantined, []);
}));

test('finalize: a PDF whose stored size differs from the claim is still size_mismatch (exact match kept for non-Office)', () => withEnv(ENV, async () => {
  const r = await finalize({ itemPath: P, claimedSize: 5000, itemSize: 5100, head: PDF });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'size_mismatch');
}));

// ---------- scoring run ----------
test('runScoring: a stored item over the scoring ceiling is marked unavailable without downloading it', async () => {
  const { runScoring } = await load('_shared/broker-scoring-run.mjs');
  const results = []; let downloaded = false;
  const r = await runScoring({ submissionId: 'sub-1', itemPath: P, fields: {} }, {
    hasBeenScoredImpl: async () => false, markScoredImpl: async () => {},
    getItemByPathImpl: async () => ({ size: limits.MAX_SCORING_BYTES + 1 }),
    getFileContentImpl: async () => { downloaded = true; return Buffer.alloc(1); },
    writeScoreResultImpl: async (id, v) => results.push(v),
    forwardToNetlifyFormImpl: async () => true,
  });
  assert.equal(downloaded, false);
  assert.equal(r.reason, 'file_too_large_for_scoring');
  assert.deepEqual(results, [{ status: 'unavailable', reason: 'file_too_large_for_scoring' }]);
});

test('runScoring: the download is bounded by maxBytes, and a too_large error becomes the unavailable path', async () => {
  const { runScoring } = await load('_shared/broker-scoring-run.mjs');
  const results = []; let opts;
  const r = await runScoring({ submissionId: 'sub-2', itemPath: P, fields: {} }, {
    hasBeenScoredImpl: async () => false, markScoredImpl: async () => {},
    getItemByPathImpl: async () => ({ size: 1000 }), // Graph under-reported; the stream is bigger
    getFileContentImpl: async (p, o) => { opts = o; throw Object.assign(new Error('big'), { code: 'too_large' }); },
    writeScoreResultImpl: async (id, v) => results.push(v),
    forwardToNetlifyFormImpl: async () => true,
  });
  assert.equal(opts.maxBytes, limits.MAX_SCORING_BYTES);
  assert.equal(r.reason, 'file_too_large_for_scoring');
  assert.equal(results[0].status, 'unavailable');
});

test('runScoring: end to end, a zip-bomb xlsx never reaches the LLM and lands on the unavailable path', async () => {
  const { runScoring } = await load('_shared/broker-scoring-run.mjs');
  const bomb = buildZip([CT, { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(8 * 1024 * 1024), declaredSize: 10 }]);
  const results = []; let llm = 0;
  const r = await runScoring({ submissionId: 'sub-3', itemPath: 'Broker Submissions/2026-10-18_Acme_ab12cd34/rr.xlsx', fields: {} }, {
    hasBeenScoredImpl: async () => false, markScoredImpl: async () => {},
    getItemByPathImpl: async () => ({ size: bomb.length }),
    getFileContentImpl: async () => bomb,
    extractDealTermsImpl: async () => { llm += 1; return {}; },
    writeScoreResultImpl: async (id, v) => results.push(v),
    forwardToNetlifyFormImpl: async () => true,
  });
  assert.equal(llm, 0);
  assert.equal(r.reason, 'archive_too_large');
  assert.deepEqual(results, [{ status: 'unavailable', reason: 'archive_too_large' }]);
});
