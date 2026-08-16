'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guard for the failure class that broke production TWICE on 2026-08-16.
//
// Netlify bundles V2 (ESM) functions with esbuild. When an ESM entry pulls in a
// CommonJS module, esbuild INLINES that module's source but leaves its
// `require('some-package')` as a runtime __require call -- and the package is
// not in the bundle. The function then dies at module load, before any catch
// block exists, so nothing is logged and nothing is written. From outside it is
// indistinguishable from "still pending".
//
// It cost two production round-trips to learn:
//   1. broker-score-store.js -> "Cannot find module '@netlify/blobs'"
//   2. broker-extraction.js  -> "Cannot find module 'xlsx'"
// Both were invisible to the entire local suite, which passed throughout.
//
// The rule this encodes: any CommonJS module reachable by ESM import from a V2
// function entry must not require a bare (non-builtin) package. Convert it to
// ESM instead, so esbuild bundles the dependency.
//
// This is a static check on purpose -- it needs no network, no deploy, and no
// bundler, so it runs in the same second as every other test.

const FUNCTIONS_DIR = path.join(__dirname, '..', '..', 'netlify', 'functions');

const RELATIVE_IMPORT = /(?:^|\n)\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['"](\.[^'"]+)['"]/g;
const RELATIVE_REQUIRE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const BARE_REQUIRE = /require\(\s*['"]([a-zA-Z@][^'"]*)['"]\s*\)/g;

function readIfExists(p) {
  return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
}

function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, `${base}.json`]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function matchAll(src, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// Walks outward from an ESM entry, returning every CJS file esbuild would inline
// into that function's bundle.
function collectCjsReachableFromEsm(entry) {
  const seen = new Set();
  const cjs = new Set();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    const src = readIfExists(file);
    if (src === null || file.endsWith('.json')) continue;

    if (file.endsWith('.js')) cjs.add(file);

    for (const spec of [...matchAll(src, RELATIVE_IMPORT), ...matchAll(src, RELATIVE_REQUIRE)]) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return cjs;
}

const esmEntries = fs.readdirSync(FUNCTIONS_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => path.join(FUNCTIONS_DIR, f));

test('there is at least one V2 function to check (guards against a vacuous pass)', () => {
  assert.ok(esmEntries.length > 0, 'no .mjs functions found -- this test would silently pass forever');
});

for (const entry of esmEntries) {
  const name = path.basename(entry);
  test(`${name}: no ESM-reachable CommonJS module requires a bare package`, () => {
    const offenders = [];
    for (const cjsFile of collectCjsReachableFromEsm(entry)) {
      const src = fs.readFileSync(cjsFile, 'utf8');
      for (const pkg of matchAll(src, BARE_REQUIRE)) {
        if (pkg.startsWith('node:')) continue; // builtins always resolve at runtime
        offenders.push(`${path.relative(FUNCTIONS_DIR, cjsFile)} requires '${pkg}'`);
      }
    }
    assert.deepEqual(
      offenders, [],
      `${name} would deploy without these dependencies bundled, and die at module load ` +
      `with "Cannot find module" -- silently, because a background function's crash is ` +
      `never surfaced to the caller. Convert the offending module to ESM so esbuild ` +
      `bundles the dependency:\n  ${offenders.join('\n  ')}`,
    );
  });
}
