// Source-level guards for client scripts that have no exports and no browser
// harness (2026-09-25 website-perfection audit). Each pins a defect that a
// blocked-storage browser, a 5xx from Netlify, or a dead code path produced.
//
// Why source-level: chat.js and script.js are IIFEs; the failure modes below
// (a SecurityError from Web Storage in Safari "Block all cookies" / some
// private modes, a plain-text 502 body) are environmental and cannot be
// provoked by the form-validator DOM stub. Pinning the guard pattern is the
// cheapest check that survives a re-minify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Every `sessionStorage.` / `localStorage.` member access must sit inside a
// try block. Approximation that is exact for these two files: the access must
// appear between a `try{`/`try {` and the next `catch`.
function unguardedStorageAccesses(src) {
  const out = [];
  for (const m of src.matchAll(/\b(sessionStorage|localStorage)\.(getItem|setItem|removeItem)\(/g)) {
    const before = src.slice(0, m.index);
    const lastTry = Math.max(before.lastIndexOf('try{'), before.lastIndexOf('try {'));
    const lastCatch = before.lastIndexOf('catch');
    if (lastTry < 0 || lastCatch > lastTry) out.push(m[0]);
  }
  return out;
}

test('chat.js wraps every Web Storage access in try/catch (blocked storage must not kill the widget)', () => {
  assert.deepEqual(unguardedStorageAccesses(read('assets/chat.js')), []);
});

test('script.js wraps every Web Storage access in try/catch (blocked storage must not abort the DOMContentLoaded chain)', () => {
  assert.deepEqual(unguardedStorageAccesses(read('script.js')), []);
});

test('broker-upload.js never calls res.json() on a response that may be plain text (Netlify 502/504 bodies)', () => {
  const src = read('broker-upload.js');
  assert.ok(!/await\s+res\.json\(\)/.test(src), 'broker-upload.js still parses every response with res.json(); a 502 "Task timed out" body throws SyntaxError into the user-facing message');
  assert.match(src, /async function readJson\(/, 'expected a readJson(res) helper that tolerates non-JSON bodies');
});

test('application-script.js carries no dead listings populator (nothing on the site defines window.ORA_LISTINGS)', () => {
  const src = read('application-script.js');
  assert.ok(!/window\.ORA_LISTINGS|window\.listings/.test(src), 'application-script.js still reads window.ORA_LISTINGS / window.listings, which no page defines');
});

test('listings.js size filter matches on any unit, not total-property SF vs. first-unit SF', () => {
  const src = read('listings.js');
  const block = src.slice(src.indexOf('if (size) {'), src.indexOf('if (size) {') + 600);
  assert.ok(block.length > 0, 'size filter block not found');
  assert.ok(!/totalSF\(p\)/.test(block), 'size filter still compares the SUM of all units against the lower bound');
  assert.ok(!/p\.units\[0\]/.test(block), 'size filter still checks only the first unit against the upper bound');
  assert.match(block, /p\.units\.some\(/, 'size filter should ask whether ANY unit falls in the range');
});
