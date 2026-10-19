'use strict';
const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// broker-extraction is ESM so esbuild bundles xlsx/mammoth into the function
// (as CJS from an ESM entry they were left as unresolvable runtime requires --
// confirmed in production). Load lazily and delegate; assertions unchanged.
let extractionModulePromise;
function loadExtraction() {
  extractionModulePromise ||= import(
    pathToFileURL(path.join(__dirname, '..', '..', '..', 'netlify', 'functions', '_shared', 'broker-extraction.mjs')).href
  );
  return extractionModulePromise;
}
const extractForScoring = (...a) => loadExtraction().then((m) => m.extractForScoring(...a));
let MAX_SCORING_BYTES;
before(async () => { MAX_SCORING_BYTES = (await loadExtraction()).MAX_SCORING_BYTES; });

test('extractForScoring passes a PDF through as base64, untouched', async () => {
  const buf = Buffer.from('%PDF-1.4 fake pdf content');
  const result = await extractForScoring(buf, 'pdf');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'pdf');
  assert.equal(result.base64, buf.toString('base64'));
});

test('extractForScoring rejects a file over the scoring size ceiling before doing any parsing work', async () => {
  const buf = Buffer.alloc(MAX_SCORING_BYTES + 1);
  const result = await extractForScoring(buf, 'pdf');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'file_too_large_for_scoring');
});

test('extractForScoring converts an XLSX workbook to CSV-per-sheet text', async () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Tenant', 'SF'], ['Acme Co', 5000]]);
  XLSX.utils.book_append_sheet(wb, ws, 'Rent Roll');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const result = await extractForScoring(buf, 'xlsx');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'text');
  assert.match(result.text, /Rent Roll/);
  assert.match(result.text, /Acme Co/);
});

test('extractForScoring converts an XLS (BIFF8/OLE2) workbook to CSV-per-sheet text', async () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Property', 'Rent'], ['Main St', 10000]]);
  XLSX.utils.book_append_sheet(wb, ws, 'Leases');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
  const result = await extractForScoring(buf, 'xls');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'text');
  assert.match(result.text, /Leases/);
  assert.match(result.text, /Main St/);
});

test('extractForScoring returns unparseable_file for zip-signature garbage claiming to be xlsx', async () => {
  const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('this is not a real spreadsheet')]);
  const result = await extractForScoring(buf, 'xlsx');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unparseable_file');
});

test('extractForScoring returns legacy_doc_unsupported for .doc without attempting to parse it', async () => {
  const buf = Buffer.from('legacy binary doc content');
  const result = await extractForScoring(buf, 'doc');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy_doc_unsupported');
});

test('extractForScoring returns unsupported_file_type for anything else', async () => {
  const result = await extractForScoring(Buffer.from('x'), 'txt');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_file_type');
});
