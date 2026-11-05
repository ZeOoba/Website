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
// Every function that reaches Blobs -- directly, or transitively through
// _shared/ -- MUST be V2 (default export, Request in / Response out) or that
// function is dead in production while every local unit test still passes. That
// gap is exactly how this shipped broken and stayed broken for twelve days.
//
// The set of Blobs-backed functions is DERIVED by an import scan, not hard-coded:
// a hand-kept list silently missed signature-alert.mjs (the webhook-secret
// rotation alarm). The scan follows static import/export-from, require() and
// dynamic import() edges, after stripping // and /* */ comments, so a comment
// that merely mentions @netlify/blobs does not count.

const FUNCTIONS_DIR = path.join(__dirname, '..', '..', 'netlify', 'functions');
const FIXTURE_DIR = path.join(__dirname, '_fixtures', 'v2-scan');

// ---- scanner ---------------------------------------------------------------

const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'case', 'do', 'else', 'in', 'of', 'new',
  'delete', 'void', 'throw', 'yield', 'await',
]);

// Replaces every // and /* */ comment with spaces (newlines kept), leaving
// string, template and regex literals intact. A regex/string-aware pass rather
// than a bare regex, because "/*" and "//" occur inside ordinary string and
// regex literals in this codebase (globs, URLs) and a naive strip would swallow
// the real code that follows them.
function stripComments(src) {
  let out = '';
  let i = 0;
  let lastSig = ''; // last significant (non-space, non-comment) char emitted
  let lastWord = '';
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break; // unterminated: stop at EOL
        j++;
      }
      j = Math.min(j + 1, n);
      out += src.slice(i, j);
      i = j;
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '/') {
      const regexStart = lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || REGEX_PRECEDING_WORDS.has(lastWord);
      if (regexStart) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          j++;
        }
        j = Math.min(j + 1, n);
        while (j < n && /[a-z]/i.test(src[j])) j++; // flags
        out += src.slice(i, j);
        i = j;
        lastSig = '/';
        lastWord = '';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) {
      if (/[\w$]/.test(c)) {
        lastWord = /[\w$]/.test(lastSig) ? lastWord + c : c;
      } else {
        lastWord = '';
      }
      lastSig = c;
    }
    i++;
  }
  return out;
}

const SPECIFIER_PATTERNS = [
  // import x from 'y' / import { a } from 'y' / import 'y' / export { a } from 'y' / export * from 'y'
  /\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?['"]([^'"\n]+)['"]/g,
  // dynamic import('y')
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // require('y')
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

function extractSpecifiers(src) {
  const code = stripComments(src);
  const specs = [];
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
  }
  return specs;
}

function isBlobsSpecifier(spec) {
  return spec === '@netlify/blobs' || spec.startsWith('@netlify/blobs/');
}

function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, `${base}.json`]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function reachesBlobs(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    for (const spec of extractSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (isBlobsSpecifier(spec)) return true;
      if (spec.startsWith('.')) {
        const resolved = resolveSpecifier(file, spec);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return false;
}

// Top-level *.js / *.mjs entries in rootDir (Netlify's function entries) that
// reach @netlify/blobs. Returns sorted entry names without extension.
function findBlobsBackedEntries(rootDir) {
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(m?js)$/.test(e.name) && !e.name.endsWith('.test.js'))
    .filter((e) => reachesBlobs(path.join(rootDir, e.name)))
    .map((e) => e.name.replace(/\.m?js$/, ''))
    .sort();
}

// Returns the list of V2-contract violations for an imported module ([] = ok).
function v2ContractViolations(mod) {
  const problems = [];
  if (typeof mod.default !== 'function') problems.push('must expose a default export (V2)');
  if (mod.handler !== undefined) problems.push('must NOT export "handler" -- that marks it legacy V1 and breaks Blobs');
  return problems;
}

function resolveEntryFile(rootDir, name) {
  for (const ext of ['.mjs', '.js']) {
    const candidate = path.join(rootDir, `${name}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no function file found for "${name}" in ${rootDir}`);
}

async function importEntry(rootDir, name) {
  return import(pathToFileURL(resolveEntryFile(rootDir, name)).href);
}

function listFilesRecursive(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(full, ...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

// ---- scanner self-tests (synthetic scan root) ------------------------------
// tests/functions/_fixtures/v2-scan/ is scanned as if it were netlify/functions.
// Only v2-direct.mjs and v1-handler-regression.mjs are ever imported.

test('scanner: flags direct, transitive (require), dynamic import() and post-literal imports; ignores comments', () => {
  assert.deepEqual(findBlobsBackedEntries(FIXTURE_DIR), [
    'dynamic-direct',
    'dynamic-transitive',
    'tricky-positive',
    'v1-handler-regression',
    'v1-transitive',
    'v2-direct',
  ]);
});

test('scanner: a // or /* */ comment mentioning @netlify/blobs does not flag an entry', () => {
  const flagged = new Set(findBlobsBackedEntries(FIXTURE_DIR));
  for (const name of ['comment-line', 'comment-block', 'tricky-negative', 'no-blobs']) {
    assert.ok(!flagged.has(name), `${name} must not be flagged`);
  }
});

test('stripComments keeps string and regex literals and blanks comments', () => {
  assert.equal(stripComments("a // c\nb"), 'a     \nb');
  assert.equal(stripComments('x /* y */ z'), 'x         z');
  assert.equal(stripComments("'//not' '/*not*/'"), "'//not' '/*not*/'");
  assert.equal(stripComments('const r = /\\/\\//g; // c'), 'const r = /\\/\\//g;     ');
  assert.equal(stripComments('const q = a / b; // c'), 'const q = a / b;     ');
});

test('contract helper accepts a V2 Blobs entry', async () => {
  assert.deepEqual(v2ContractViolations(await importEntry(FIXTURE_DIR, 'v2-direct')), []);
});

test('contract helper rejects a Blobs entry that exports handler (V1 regression)', async () => {
  const problems = v2ContractViolations(await importEntry(FIXTURE_DIR, 'v1-handler-regression'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /handler/);
});

// ---- the real contract -----------------------------------------------------

const BLOBS_BACKED_FUNCTIONS = findBlobsBackedEntries(FUNCTIONS_DIR);

test('derived Blobs-backed set is non-vacuous and includes every known Blobs function', () => {
  for (const name of ['broker-finalize', 'broker-score-background', 'broker-score-status', 'signature-alert']) {
    assert.ok(BLOBS_BACKED_FUNCTIONS.includes(name), `${name} must be detected as Blobs-backed; got ${JSON.stringify(BLOBS_BACKED_FUNCTIONS)}`);
  }
});

test('no fixture file lives under netlify/functions (it would deploy as a live function)', () => {
  const offenders = listFilesRecursive(FUNCTIONS_DIR)
    .map((f) => path.relative(FUNCTIONS_DIR, f))
    .filter((rel) => /fixture/i.test(rel));
  assert.deepEqual(offenders, []);
});

for (const name of BLOBS_BACKED_FUNCTIONS) {
  test(`${name} is a V2 function so Netlify Blobs auto-provisions`, async () => {
    const problems = v2ContractViolations(await importEntry(FUNCTIONS_DIR, name));
    assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`);
  });
}

test('broker-score-status default export accepts a Request and returns a Response', async () => {
  const mod = await importEntry(FUNCTIONS_DIR, 'broker-score-status');
  const res = await mod.default(new Request('https://oxfordra.net/api/broker-score-status', { method: 'POST' }));
  assert.ok(res instanceof Response, 'V2 handlers must return a Response');
  assert.equal(res.status, 405);
});

test('broker-score-status reads submissionId from the V2 request URL, not event.queryStringParameters', async () => {
  const mod = await importEntry(FUNCTIONS_DIR, 'broker-score-status');
  const res = await mod.default(new Request('https://oxfordra.net/api/broker-score-status', { method: 'GET' }));
  assert.equal(res.status, 400, 'a GET with no submissionId must still be a 400 under the V2 signature');
  assert.equal((await res.json()).error, 'missing_submission_id');
});
