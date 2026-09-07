'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyRecaptcha } = require('../../../netlify/functions/_shared/recaptcha.js');

test('verifyRecaptcha returns { success: true } on a successful Google siteverify response', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://www.google.com/recaptcha/api/siteverify');
    return { ok: true, json: async () => ({ success: true }) };
  };
  const result = await verifyRecaptcha('a-real-token', { fetchImpl, secret: 'test-secret' });
  assert.equal(result.success, true);
  assert.equal(result.errorCodes, null);
});

test('verifyRecaptcha returns success:false and the error-codes Google reports on failure', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
  const result = await verifyRecaptcha('a-bad-token', { fetchImpl, secret: 'test-secret' });
  assert.equal(result.success, false);
  assert.deepEqual(result.errorCodes, ['invalid-input-response']);
});

test('verifyRecaptcha returns success:false with missing-input-response for an empty token, without calling the network', async () => {
  const fetchImpl = async () => { throw new Error('must not call network'); };
  const result = await verifyRecaptcha('', { fetchImpl, secret: 'test-secret' });
  assert.equal(result.success, false);
  assert.deepEqual(result.errorCodes, ['missing-input-response']);
});

test('verifyRecaptcha returns success:false with an http-<status> code when Google itself errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const result = await verifyRecaptcha('a-token', { fetchImpl, secret: 'test-secret' });
  assert.equal(result.success, false);
  assert.deepEqual(result.errorCodes, ['http-503']);
});

test('verifyRecaptcha throws if RECAPTCHA_SECRET_KEY is not configured', async () => {
  await assert.rejects(() => verifyRecaptcha('token', { fetchImpl: async () => ({ ok: true, json: async () => ({}) }), secret: undefined }));
});
