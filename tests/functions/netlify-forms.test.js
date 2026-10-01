'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { forwardToNetlifyForm } = require('../../netlify/functions/_shared/netlify-forms.js');

// forwardToNetlifyForm is the primitive under both the durable ledger rows and
// the pipeline-failures alert channel. It used to return undefined whatever
// happened, so a caller could not tell a delivered row from a dropped one.
// Contract now: true only on a 2xx, false otherwise, and it never throws (every
// legacy fire-and-forget caller must keep working unchanged).

const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

test('returns true and posts urlencoded form data on a 2xx', async () => {
  let seen;
  const ok = await forwardToNetlifyForm('https://oxfordra.net', 'broker-network-ledger', { name: 'Bob', empty: null }, {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200 }; },
  });
  assert.equal(ok, true);
  assert.equal(seen.url, 'https://oxfordra.net/');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(seen.opts.body, 'form-name=broker-network-ledger&name=Bob&empty=');
});

test('returns false (does not throw) on a non-2xx response', () => quiet(async () => {
  const ok = await forwardToNetlifyForm('https://oxfordra.net', 'pipeline-failures', { a: '1' }, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(ok, false);
}));

test('returns false (does not throw) when the network call itself throws', () => quiet(async () => {
  const ok = await forwardToNetlifyForm('https://oxfordra.net', 'pipeline-failures', { a: '1' }, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(ok, false);
}));
