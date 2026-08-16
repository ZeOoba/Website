'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Regression guard for the 2026-08-04 production outage.
//
// Netlify classifies a function as legacy V1 when its module exports `handler`.
// Netlify's own coding context states Blobs auto-provisioning "does NOT apply to
// legacy V1 functions which require manual siteID/token configuration" -- so every
// getStore() call made from a V1 function throws MissingBlobsEnvironmentError in
// production, no matter what the code around it looks like.
//
// These three functions reach Blobs through _shared/broker-score-store.js. They
// MUST be V2 (default export, Request in / Response out) or scoring is dead in
// production while every local unit test still passes. That gap is exactly how
// this shipped broken and stayed broken for twelve days.

const FUNCTIONS_DIR = path.join(__dirname, '..', '..', 'netlify', 'functions');
const BLOBS_BACKED_FUNCTIONS = ['broker-finalize', 'broker-score-background', 'broker-score-status'];

function resolveFunctionFile(name) {
  for (const ext of ['.mjs', '.js']) {
    const candidate = path.join(FUNCTIONS_DIR, `${name}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no function file found for "${name}" in ${FUNCTIONS_DIR}`);
}

async function importFunction(name) {
  return import(pathToFileURL(resolveFunctionFile(name)).href);
}

for (const name of BLOBS_BACKED_FUNCTIONS) {
  test(`${name} is a V2 function so Netlify Blobs auto-provisions`, async () => {
    const mod = await importFunction(name);
    assert.equal(typeof mod.default, 'function', `${name} must expose a default export (V2)`);
    assert.equal(mod.handler, undefined, `${name} must NOT export "handler" -- that marks it legacy V1 and breaks Blobs`);
  });
}

test('broker-score-status default export accepts a Request and returns a Response', async () => {
  const mod = await importFunction('broker-score-status');
  const res = await mod.default(new Request('https://oxfordra.net/api/broker-score-status', { method: 'POST' }));
  assert.ok(res instanceof Response, 'V2 handlers must return a Response');
  assert.equal(res.status, 405);
});

test('broker-score-status reads submissionId from the V2 request URL, not event.queryStringParameters', async () => {
  const mod = await importFunction('broker-score-status');
  const res = await mod.default(new Request('https://oxfordra.net/api/broker-score-status', { method: 'GET' }));
  assert.equal(res.status, 400, 'a GET with no submissionId must still be a 400 under the V2 signature');
  assert.equal((await res.json()).error, 'missing_submission_id');
});
