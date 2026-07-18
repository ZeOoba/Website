'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyRecaptcha } = require('../../../netlify/functions/_shared/recaptcha.js');

test('verifyRecaptcha returns true on a successful Google siteverify response', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://www.google.com/recaptcha/api/siteverify');
    return { ok: true, json: async () => ({ success: true }) };
  };
  const result = await verifyRecaptcha('a-real-token', { fetchImpl, secret: 'test-secret' });
  assert.equal(result, true);
});

test('verifyRecaptcha returns false when Google reports failure', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: false }) });
  const result = await verifyRecaptcha('a-bad-token', { fetchImpl, secret: 'test-secret' });
  assert.equal(result, false);
});

test('verifyRecaptcha returns false immediately for an empty token, without calling the network', async () => {
  const fetchImpl = async () => { throw new Error('must not call network'); };
  const result = await verifyRecaptcha('', { fetchImpl, secret: 'test-secret' });
  assert.equal(result, false);
});

test('verifyRecaptcha throws if RECAPTCHA_SECRET_KEY is not configured', async () => {
  await assert.rejects(() => verifyRecaptcha('token', { fetchImpl: async () => ({ ok: true, json: async () => ({}) }), secret: undefined }));
});
