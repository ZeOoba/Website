'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  checkHoneypot,
  sniffFileType,
  isAllowedUpload,
  sanitizeField,
  verifyNetlifyWebhookSignature,
  signIntakeToken,
  verifyIntakeToken,
} = require('../../../netlify/functions/_shared/validate.js');

test('checkHoneypot flags a filled bot-field or website field', () => {
  assert.equal(checkHoneypot({ 'bot-field': '' }), false);
  assert.equal(checkHoneypot({ 'bot-field': 'spam' }), true);
  assert.equal(checkHoneypot({ website: 'http://spam.example' }), true);
  assert.equal(checkHoneypot({}), false);
});

test('sniffFileType detects PDF, JPEG, PNG, DOCX/XLSX(zip) by magic bytes', () => {
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // docx/xlsx are zip containers
  const junk = Buffer.from([0x00, 0x01, 0x02]);
  assert.equal(sniffFileType(pdf).ext, 'pdf');
  assert.equal(sniffFileType(jpeg).ext, 'jpg');
  assert.equal(sniffFileType(png).ext, 'png');
  assert.equal(sniffFileType(zip).ext, 'zip-based');
  assert.equal(sniffFileType(junk), null);
});

test('isAllowedUpload rejects an .exe renamed to .pdf', () => {
  const exeBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // "MZ" PE header
  assert.equal(isAllowedUpload('resume.pdf', exeBytes, ['pdf', 'jpg', 'png']), false);
});

test('isAllowedUpload accepts a real PDF with a pdf extension', () => {
  const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.equal(isAllowedUpload('report.pdf', pdfBytes, ['pdf', 'jpg', 'png']), true);
});

test('isAllowedUpload accepts a zip-based Office doc when xlsx/docx are allowed', () => {
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  assert.equal(isAllowedUpload('rentroll.xlsx', zipBytes, ['pdf', 'xlsx', 'xls', 'doc', 'docx']), true);
});

test('sanitizeField trims, strips control characters, and truncates', () => {
  assert.equal(sanitizeField('  hello\0world  ', 20), 'helloworld');
  assert.equal(sanitizeField('a'.repeat(500), 10), 'a'.repeat(10));
  assert.equal(sanitizeField(null, 10), '');
});

test('verifyNetlifyWebhookSignature accepts a correctly signed body and rejects a tampered one', () => {
  const secret = 'test-webhook-secret';
  const rawBody = JSON.stringify({ form_name: 'commercial-lease-application', data: { email: 'a@b.com' } });
  const sha256 = crypto.createHash('sha256').update(rawBody).digest('hex');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: 'netlify', sha256 };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  const jws = `${signingInput}.${sig}`;

  assert.equal(verifyNetlifyWebhookSignature(rawBody, jws, secret), true);
  assert.equal(verifyNetlifyWebhookSignature(rawBody + 'tampered', jws, secret), false);
  assert.equal(verifyNetlifyWebhookSignature(rawBody, jws, 'wrong-secret'), false);
  assert.equal(verifyNetlifyWebhookSignature(rawBody, 'not-a-jws', secret), false);
});

test('signIntakeToken/verifyIntakeToken round-trip and reject tampering', () => {
  const secret = 'intake-secret';
  const token = signIntakeToken({ path: 'Broker Submissions/x', size: 1000, exp: Date.now() + 60_000 }, secret);
  const verified = verifyIntakeToken(token, secret);
  assert.equal(verified.path, 'Broker Submissions/x');
  assert.equal(verifyIntakeToken(token, 'wrong-secret'), null);
  assert.equal(verifyIntakeToken(token + 'x', secret), null);
});

// An unset NETLIFY_WEBHOOK_SECRET used to reach crypto.createHmac(undefined) and
// throw a TypeError out of the verifier — a 500 that skipped the callers'
// invalid-signature 401 path (now console.error only), so a rotated/missing secret was silent
// (2026-09-25 audit). verifyIntakeToken already fails closed here; match it.
test('verifyNetlifyWebhookSignature fails closed (false, no throw) when the secret is unset or empty', () => {
  const header = { alg: 'HS256' };
  const payload = { iss: 'netlify', sha256: crypto.createHash('sha256').update('{}').digest('hex') };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const jws = `${b64url(header)}.${b64url(payload)}.${b64url({})}`;
  assert.equal(verifyNetlifyWebhookSignature('{}', jws, undefined), false);
  assert.equal(verifyNetlifyWebhookSignature('{}', jws, ''), false);
});

test('verifyIntakeToken rejects an expired token', () => {
  const secret = 'intake-secret';
  const token = signIntakeToken({ path: 'p', size: 1, exp: Date.now() - 1000 }, secret);
  assert.equal(verifyIntakeToken(token, secret), null);
});
