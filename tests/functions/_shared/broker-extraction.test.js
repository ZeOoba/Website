'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { extractForScoring, MAX_SCORING_BYTES } = require('../../../netlify/functions/_shared/broker-extraction.js');

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

test('extractForScoring returns unparseable_file for garbage bytes claiming to be xlsx', async () => {
  const buf = Buffer.from('this is not a real spreadsheet');
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
