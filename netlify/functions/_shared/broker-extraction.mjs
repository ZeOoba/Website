// ESM so Netlify's esbuild bundles xlsx and mammoth INTO the function.
// As CommonJS reached from an ESM (V2) entry, esbuild inlined this module but
// left its require('xlsx') as a runtime __require call with the package absent
// from the bundle -- confirmed in production:
//   "Cannot find module 'xlsx'" at broker-score-background.mjs:184
// Under the old V1 bundler node_modules shipped alongside the function, so the
// require resolved; V2 bundles instead, and these two fell through.
import XLSX from 'xlsx';
import mammoth from 'mammoth';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The size/row/char/archive limits live in broker-limits.js (one home for finalize, scoring and the prompt
// builder). Re-exported here so existing importers of MAX_SCORING_BYTES keep working.
import limits from './broker-limits.js';

const {
  MAX_SCORING_BYTES, MAX_EXTRACTED_SHEETS, MAX_ROWS_PER_SHEET, MAX_COLS_PER_SHEET, MAX_DOCX_XML_BYTES, MAX_DOCX_XML_TOTAL_BYTES, MAX_HYPERLINK_AREA, MAX_EXTRACTED_CHARS,
  PARSE_TIMEOUT_MS, PARSE_HEAP_MB,
  matchesDeclaredOmType, inspectZip, truncationMarker, capText,
} = limits;

const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
const isZip = (buffer) => buffer.length >= 4 && ZIP_SIG.every((b, i) => buffer[i] === b);

// Legacy .xls (OLE2): SheetJS creates a cell object for every address inside each HLink (0x01B8) and HLinkTooltip
// (0x0800) range while reading, ignoring sheetRows, so a few KB can declare a whole sheet and run for minutes.
// Walk the Workbook stream's BIFF records first (cheap, linear) and refuse any hyperlink wider than the
// extraction window. Returns true (bomb), false (fine) or 'unparseable'.
function biffHyperlinkBomb(buffer) {
  let cfb;
  try { cfb = XLSX.CFB.read(buffer, { type: 'buffer' }); } catch { return 'unparseable'; }
  const stream = XLSX.CFB.find(cfb, 'Workbook') || XLSX.CFB.find(cfb, 'Book');
  if (!stream || !stream.content) return false;
  const buf = Buffer.from(stream.content);
  let pos = 0;
  let total = 0;
  while (pos + 4 <= buf.length) {
    const id = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    const refAt = id === 0x01b8 ? pos + 4 : (id === 0x0800 ? pos + 6 : -1);
    if (refAt >= 0 && refAt + 8 <= pos + 4 + size && refAt + 8 <= buf.length) {
      const rows = Math.abs(buf.readUInt16LE(refAt + 2) - buf.readUInt16LE(refAt)) + 1;
      const cols = Math.abs(buf.readUInt16LE(refAt + 6) - buf.readUInt16LE(refAt + 4)) + 1;
      total += rows * cols; // summed across records, like the xlsx scan
      if (total > MAX_HYPERLINK_AREA) return true;
    }
    pos += 4 + size;
  }
  return false;
}

// Every non-ok result here routes to the "scoring unavailable" fallback in broker-scoring-run (nothing is sent
// to the LLM). Over-cap TEXT is the one soft case: it is cut deterministically with a visible marker instead.
async function extractForScoring(buffer, ext, opts = {}) {
  if (buffer.length > MAX_SCORING_BYTES) {
    return { ok: false, reason: 'file_too_large_for_scoring' };
  }

  // Legacy binary .doc (OLE compound format) is NOT parseable by mammoth (docx-only) -- do not attempt it and
  // risk an unpredictable throw; fail cleanly so the caller routes to the existing graceful fallback.
  if (ext === 'doc') {
    return { ok: false, reason: 'legacy_doc_unsupported' };
  }
  if (!['pdf', 'xlsx', 'xls', 'docx'].includes(ext)) {
    return { ok: false, reason: 'unsupported_file_type' };
  }

  // The declared extension is only a claim: check the real leading bytes, so a renamed file never reaches a
  // parser or the document block. Distinct from unparseable_file so a spoof is visible in pipeline-failures.
  if (!matchesDeclaredOmType(ext, buffer)) {
    return { ok: false, reason: 'file_type_mismatch' };
  }

  if (ext === 'pdf') {
    return { ok: true, kind: 'pdf', base64: buffer.toString('base64') };
  }

  // OOXML (and any zip-wrapped .xls) is a zip: bound the inflation BEFORE any parser touches it.
  if (isZip(buffer)) {
    const zip = inspectZip(buffer, { requireContentTypes: true, ...(ext === 'docx' ? { maxXmlEntryBytes: MAX_DOCX_XML_BYTES, maxXmlTotalBytes: MAX_DOCX_XML_TOTAL_BYTES } : {}) });
    if (!zip.ok) {
      return { ok: false, reason: ['zip_malformed', 'zip64_unsupported', 'zip_unsupported_method', 'zip_inconsistent', 'zip_unsupported_content'].includes(zip.reason) ? 'unparseable_file' : 'archive_too_large' };
    }
  }

  // The pre-checks above are cheap, linear filters. They cannot enumerate everything SheetJS and mammoth will
  // expand (every pass of adversarial review found another range or attribute spelling they loop over), so the
  // parse itself runs in a CHILD PROCESS with a V8 heap ceiling and a wall-clock limit. A worker thread is not
  // enough: V8 can hit a fatal allocation failure that aborts the whole process (reproduced with a 1.8 KB xlsx),
  // and that must take down only the disposable child, never this function.
  if (opts.isolate === false) return parseDocument(buffer, ext);
  const isolated = await runIsolated(buffer, ext, opts);
  if (isolated.fallback) {
    console.error('[broker-extraction] isolated parse unavailable; parsing in-process');
    return parseDocument(buffer, ext);
  } // child could not START (bundled runtime): previous in-process behaviour
  return isolated;
}

// The child is this same module, forked with OM_PARSE_CHILD=1; see the entry hook at the bottom.
function runIsolated(buffer, ext, { parseTimeoutMs = PARSE_TIMEOUT_MS, heapMb = PARSE_HEAP_MB, workerPath } = {}) {
  return new Promise((resolve) => {
    let ready = false;
    let done = false;
    let child;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child) child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    };
    // Dying BEFORE the child said it was ready means the runtime could not start it (not that the file was bad).
    const lost = (reason) => finish(ready ? { ok: false, reason } : { fallback: true });
    try {
      child = fork(workerPath || fileURLToPath(import.meta.url), [], {
        // Minimal environment: the parse needs no secrets.
        env: { PATH: process.env.PATH, OM_PARSE_CHILD: '1' },
        execArgv: ['--max-old-space-size=' + heapMb],
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch {
      resolve({ fallback: true });
      return;
    }
    timer = setTimeout(() => lost('extraction_timeout'), parseTimeoutMs);
    child.on('message', (m) => {
      if (m && m.type === 'ready') {
        ready = true;
        child.send({ ext, bytes: new Uint8Array(buffer) }, () => {});
      } else if (m && m.type === 'result') {
        finish(m.result);
      }
    });
    child.on('error', () => lost('unparseable_file'));
    // A non-zero exit or a signal after "ready" is the heap ceiling (V8 fatal OOM aborts with SIGABRT / 134).
    child.on('exit', (code, signal) => lost(code === 0 && !signal ? 'unparseable_file' : 'extraction_resource_limit'));
  });
}

// Everything that runs a third-party parser on the upload. Runs inside the worker (or in-process as a fallback).
async function parseDocument(buffer, ext) {
  // OLE2 container walk lives here, not in the caller: it runs in the isolated child.
  if ((ext === 'xlsx' || ext === 'xls') && !isZip(buffer)) {
    const biff = biffHyperlinkBomb(buffer);
    if (biff === 'unparseable') return { ok: false, reason: 'unparseable_file' };
    if (biff) return { ok: false, reason: 'archive_too_large' };
  }

  if (ext === 'xlsx' || ext === 'xls') {
    let workbook;
    try {
      // sheetRows bounds what SheetJS materialises per sheet (+1 so a header-plus-cap sheet is detectable).
      workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: MAX_ROWS_PER_SHEET + 1 });
    } catch (err) {
      return { ok: false, reason: 'unparseable_file' };
    }
    const notes = [];
    const names = workbook.SheetNames.slice(0, MAX_EXTRACTED_SHEETS);
    if (workbook.SheetNames.length > names.length) notes.push(`${workbook.SheetNames.length - names.length} of ${workbook.SheetNames.length} sheets omitted (limit ${MAX_EXTRACTED_SHEETS})`);
    const parts = [];
    let joinedLen = 0;
    for (let n = 0; n < names.length; n += 1) {
      const name = names[n];
      const ws = workbook.Sheets[name];
      // Count rows from the sheet's range, not from CSV lines: a cell with line breaks would otherwise be
      // counted as several rows. sheetRows (above) already stopped SheetJS at MAX_ROWS_PER_SHEET + 1.
      if (ws && ws['!ref']) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        // Columns are clamped too: sheet_to_csv walks EVERY column of !ref for every row, and a 1 KB file can declare
        // A1:ZZZZ2000 (tens of seconds of CPU, a CSV string approaching a GB).
        const rowsOver = range.e.r - range.s.r + 1 > MAX_ROWS_PER_SHEET;
        const colsOver = range.e.c - range.s.c + 1 > MAX_COLS_PER_SHEET;
        if (rowsOver || colsOver) {
          ws['!ref'] = XLSX.utils.encode_range({ s: range.s, e: { r: rowsOver ? range.s.r + MAX_ROWS_PER_SHEET - 1 : range.e.r, c: colsOver ? range.s.c + MAX_COLS_PER_SHEET - 1 : range.e.c } });
          if (rowsOver) notes.push(`sheet "${name}" cut at ${MAX_ROWS_PER_SHEET} rows`);
          if (colsOver) notes.push(`sheet "${name}" cut at ${MAX_COLS_PER_SHEET} columns`);
        }
      }
      const part = `Sheet: ${name}\n${ws ? XLSX.utils.sheet_to_csv(ws) : ''}`;
      parts.push(part);
      joinedLen += part.length + (parts.length > 1 ? 2 : 0);
      if (joinedLen > MAX_EXTRACTED_CHARS) {
        // Past the cap: capText below cuts inside this sheet; the sheets after it never get read.
        if (n < names.length - 1) notes.push(`${names.length - 1 - n} further sheets omitted (character limit ${MAX_EXTRACTED_CHARS})`);
        break;
      }
    }
    const capped = capText(parts.join('\n\n'), MAX_EXTRACTED_CHARS, `extraction exceeded ${MAX_EXTRACTED_CHARS} characters`);
    let text = capped.text;
    if (notes.length) text += truncationMarker(notes.join('; '));
    if (!text || text.trim().length < 20) return { ok: false, reason: 'empty_extraction' };
    return { ok: true, kind: 'text', text, truncated: capped.truncated || notes.length > 0 };
  }

  // docx
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch (err) {
    return { ok: false, reason: 'unparseable_file' };
  }
  const raw = result && result.value;
  if (!raw || raw.trim().length < 20) return { ok: false, reason: 'empty_extraction' };
  const capped = capText(raw, MAX_EXTRACTED_CHARS, `document exceeded ${MAX_EXTRACTED_CHARS} characters`);
  return { ok: true, kind: 'text', text: capped.text, truncated: capped.truncated };
}


// Child entry: only active when this module is loaded as the isolated parse child (forked with OM_PARSE_CHILD=1).
if (process.env.OM_PARSE_CHILD === '1' && typeof process.send === 'function') {
  const reply = (result) => process.send({ type: 'result', result }, () => process.exit(0));
  process.once('message', (m) => {
    parseDocument(Buffer.from(m.bytes), m.ext).then(reply, () => reply({ ok: false, reason: 'unparseable_file' }));
  });
  process.on('disconnect', () => process.exit(1)); // parent gone: do not keep parsing as an orphan
  process.send({ type: 'ready' });
}

export { extractForScoring, MAX_SCORING_BYTES };
