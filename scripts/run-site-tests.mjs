/**
 * run-site-tests.mjs — enumerate tests/site/*.test.mjs and hand `node --test` an explicit list.
 *
 * Replaces the hand-maintained 26-file list that `test:site` carried in package.json
 * (maintenance-reduction bundle 1, 2026-11-05): a new site test now runs with no config edit.
 * Enumerated here, not globbed, for the Node 20-vs-21+ reason in run-unit-tests.mjs.
 * SEPARATE files have their own npm scripts (test:functions, test:shim, test:leak-gate) and
 * different prerequisites, so they stay out of test:site.
 *
 * Run: npm run test:site      List only: node scripts/run-site-tests.mjs --list
 */
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

export const SEPARATE = [
  'functions-smoke.test.mjs',
  'leak-gate.test.mjs',
  'netlify-guard.test.mjs',
  'netlify-shim-patch.test.mjs',
];

export async function listSiteTests(root) {
  const dir = path.join(root, 'tests', 'site');
  return (await fs.readdir(dir))
    .filter((n) => n.endsWith('.test.mjs') && !SEPARATE.includes(n))
    .sort()
    .map((n) => `tests/site/${n}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);
if (isMain) {
  const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const files = await listSiteTests(ROOT);
  if (files.length === 0) {
    console.error('[run-site-tests] FAIL: no tests/site/*.test.mjs found — refusing a vacuous pass.');
    process.exit(1);
  }
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'));
    process.exit(0);
  }
  console.log(`[run-site-tests] ${files.length} test file(s)`);
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
