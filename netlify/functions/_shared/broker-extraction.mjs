// ESM so Netlify's esbuild bundles xlsx and mammoth INTO the function.
// As CommonJS reached from an ESM (V2) entry, esbuild inlined this module but
// left its require('xlsx') as a runtime __require call with the package absent
// from the bundle -- confirmed in production:
//   "Cannot find module 'xlsx'" at broker-score-background.mjs:184
// Under the old V1 bundler node_modules shipped alongside the function, so the
// require resolved; V2 bundles instead, and these two fell through.
import XLSX from 'xlsx';
import mammoth from 'mammoth';

// Anthropic caps a document-block request at 32MB/100 pages and base64 inflates
// a raw file ~33% — 20MB raw stays safely under that after encoding, per the
// pre-flight check in the design spec. Anything larger skips straight to the
// graceful "scoring unavailable" fallback rather than attempting and failing.
const MAX_SCORING_BYTES = 20 * 1024 * 1024;

async function extractForScoring(buffer, ext) {
  if (buffer.length > MAX_SCORING_BYTES) {
    return { ok: false, reason: 'file_too_large_for_scoring' };
  }

  if (ext === 'pdf') {
    return { ok: true, kind: 'pdf', base64: buffer.toString('base64') };
  }

  if (ext === 'xlsx' || ext === 'xls') {
    // XLSX files are ZIP archives (PK signature: 0x50 0x4b)
    // XLS files are OLE2 Compound File Binary (CFB signature: 0xD0 0xCF 0x11 0xE0 0xA1 0xB1 0x1A 0xE1)
    const hasZipSignature = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    const hasOle2Signature = buffer.length >= 8 &&
      buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0 &&
      buffer[4] === 0xa1 && buffer[5] === 0xb1 && buffer[6] === 0x1a && buffer[7] === 0xe1;
    if (!hasZipSignature && !hasOle2Signature) {
      return { ok: false, reason: 'unparseable_file' };
    }
    let workbook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer' });
    } catch (err) {
      return { ok: false, reason: 'unparseable_file' };
    }
    const text = workbook.SheetNames
      .map((name) => `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`)
      .join('\n\n');
    if (!text || text.trim().length < 20) return { ok: false, reason: 'empty_extraction' };
    return { ok: true, kind: 'text', text };
  }

  if (ext === 'docx') {
    let result;
    try {
      result = await mammoth.extractRawText({ buffer });
    } catch (err) {
      return { ok: false, reason: 'unparseable_file' };
    }
    const text = result && result.value;
    if (!text || text.trim().length < 20) return { ok: false, reason: 'empty_extraction' };
    return { ok: true, kind: 'text', text };
  }

  // Legacy binary .doc (OLE compound format) is NOT parseable by mammoth
  // (docx-only) — do not attempt it and risk an unpredictable throw; fail
  // cleanly so the caller routes to the existing graceful fallback.
  if (ext === 'doc') {
    return { ok: false, reason: 'legacy_doc_unsupported' };
  }

  return { ok: false, reason: 'unsupported_file_type' };
}

export { extractForScoring, MAX_SCORING_BYTES };
