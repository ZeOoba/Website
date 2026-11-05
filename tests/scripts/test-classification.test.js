'use strict';
/**
 * test-classification.test.js — every tests/site/*.test.mjs file must be run by
 * exactly one of the test:site / test:functions / test:shim npm scripts, or be
 * listed in EXCLUDED with a written reason.
 *
 * WHY: scripts/run-unit-tests.mjs auto-discovers *.test.js but deliberately
 * skips tests/site, whose .mjs browser/runtime tests are enumerated BY HAND in
 * package.json. A new tests/site file that nobody appends to a script is
 * silently never run (consent-mode.test.mjs sat orphaned this way). This guard
 * turns that omission into a red build.
 *
 * EXCLUDED maps a tests/site file name to the reason it is intentionally not
 * run by any script. It starts empty; a file listed here must NOT also appear
 * in an npm script.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SITE_DIR = path.join(ROOT, 'tests', 'site');
const SCRIPT_NAMES = ['test:site', 'test:functions', 'test:shim', 'test:leak-gate'];
const EXCLUDED = {};
const RUNNER_SCRIPT = 'test:site'; // enumerated by scripts/run-site-tests.mjs, not named in package.json

const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

// Every `tests/...test.mjs` path named in a script, normalized to forward slashes.
// test:site no longer names files: it delegates to run-site-tests.mjs, whose listSiteTests()
// is the source of truth (resolved once, below, before the tests register).
let runnerPaths = [];
function pathsIn(script, name) {
  if (name === RUNNER_SCRIPT) return runnerPaths;
  return (script.match(/tests\/[^\s"']+\.test\.mjs/g) || []).map((p) => p.replace(/\\/g, '/'));
}

const siteFiles = fs.readdirSync(SITE_DIR).filter((f) => f.endsWith('.test.mjs')).sort();

test('test:site delegates to run-site-tests.mjs', async () => {
  assert.match(scripts[RUNNER_SCRIPT], /scripts\/run-site-tests\.mjs/);
  const { listSiteTests } = await import(require('node:url').pathToFileURL(path.join(ROOT, 'scripts', 'run-site-tests.mjs')).href);
  runnerPaths = await listSiteTests(ROOT);
});

test('the npm scripts under guard exist', () => {
  for (const name of SCRIPT_NAMES) {
    assert.equal(typeof scripts[name], 'string', `package.json is missing scripts["${name}"]`);
    assert.ok(pathsIn(scripts[name], name).length > 0, `scripts["${name}"] names no tests/**/*.test.mjs file`);
  }
});

test('tests/site contains test files to classify (non-vacuous)', () => {
  assert.ok(siteFiles.length >= 20, `expected the tests/site suite, found ${siteFiles.length} file(s)`);
});

test('every tests/site/*.test.mjs is run by exactly one script, or is EXCLUDED', () => {
  const owners = new Map(siteFiles.map((f) => [f, []]));
  for (const name of SCRIPT_NAMES) {
    for (const p of pathsIn(scripts[name], name)) {
      const file = p.replace(/^tests\/site\//, '');
      if (owners.has(file)) owners.get(file).push(name);
    }
  }
  const problems = [];
  for (const [file, where] of owners) {
    const excluded = Object.prototype.hasOwnProperty.call(EXCLUDED, file);
    if (excluded && where.length) problems.push(`${file} is EXCLUDED but also runs in ${where.join(', ')}`);
    else if (!excluded && where.length === 0) problems.push(`${file} is not run by any of ${SCRIPT_NAMES.join('/')} and is not EXCLUDED`);
    else if (where.length > 1) problems.push(`${file} appears in more than one script: ${where.join(', ')}`);
  }
  assert.deepEqual(problems, [], `unclassified or double-classified test files:\n  ${problems.join('\n  ')}`);
});

test('every path named in the scripts exists (no stale entries)', () => {
  const missing = [];
  for (const name of SCRIPT_NAMES) {
    for (const p of pathsIn(scripts[name], name)) {
      if (!fs.existsSync(path.join(ROOT, p))) missing.push(`${name}: ${p}`);
    }
  }
  assert.deepEqual(missing, [], `scripts name test files that do not exist:\n  ${missing.join('\n  ')}`);
});

test('every EXCLUDED entry names a real file and carries a reason', () => {
  for (const [file, reason] of Object.entries(EXCLUDED)) {
    assert.ok(siteFiles.includes(file), `EXCLUDED["${file}"] is not a tests/site/*.test.mjs file`);
    assert.ok(typeof reason === 'string' && reason.trim().length > 10, `EXCLUDED["${file}"] needs a written reason`);
  }
});
