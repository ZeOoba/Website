'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { forwardToNetlifyForm } = require('./netlify-forms.js');

test('forwardToNetlifyForm URL-encodes fields and posts form-name to the site root', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: opts.body, headers: opts.headers, method: opts.method };
    return { ok: true, status: 200 };
  };
  await forwardToNetlifyForm('https://oxfordra.net', 'broker-network-ledger', { name: 'Bob', company: 'Acme & Co' }, { fetchImpl });
  assert.equal(captured.url, 'https://oxfordra.net/');
  assert.equal(captured.method, 'POST');
  assert.match(captured.body, /form-name=broker-network-ledger/);
  assert.match(captured.body, /company=Acme\+%26\+Co/);
});

test('forwardToNetlifyForm does not throw on a non-2xx response (best-effort ledger)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.doesNotReject(() => forwardToNetlifyForm('https://oxfordra.net', 'x', { a: '1' }, { fetchImpl }));
});
