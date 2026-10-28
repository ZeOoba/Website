'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// scripts/verify-live-csp.mjs takes the target URL from argv or SITE_URL (the live-csp workflow passes
// SITE_URL so a dispatch input is never interpolated into a shell command). Anything that is not a plain
// https origin must be refused before any request is made. The network path itself needs the live site and
// is exercised by the workflow, not here.
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'verify-live-csp.mjs');
const run = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], {
  env: { ...process.env, SITE_URL: '', ...env }, encoding: 'utf8', timeout: 15000,
});

for (const bad of ['http://oxfordra.net', 'https://a.b; rm -rf /', 'file:///etc/passwd', 'https://user@evil.example', 'oxfordra.net']) {
  test(`refuses a non-https-origin target from argv: ${JSON.stringify(bad)}`, () => {
    const r = run([bad]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /refusing to check/);
  });
  test(`refuses a non-https-origin target from SITE_URL: ${JSON.stringify(bad)}`, () => {
    const r = run([], { SITE_URL: bad });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });
}
