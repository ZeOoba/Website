/**
 * run-unit-tests.mjs — enumerate the CommonJS unit tests and hand `node --test`
 * an explicit file list.
 *
 * WHY NOT JUST `node --test tests/` OR `node --test "tests/**\/*.test.js"`:
 * the two matter here because CI runs Node 20 (pinned to netlify.toml's
 * NODE_VERSION so tests run the same major as the deploy build) while
 * developers are on newer Node, and the two disagree —
 *   - Node 20 accepts directory arguments and recurses them, but does NOT
 *     expand glob patterns,
 *   - Node 21+ expands globs, but treats a bare directory argument as a file
 *     and dies with MODULE_NOT_FOUND.
 * Either spelling therefore passes on one machine and fails on the other,
 * which is precisely the "green locally, red/absent in CI" failure mode this
 * pipeline exists to eliminate. Enumerating here is version-independent, and
 * still auto-discovers new *.test.js files with no config to update.
 *
 * Site/browser and Netlify-runtime smoke tests are NOT included: they are
 * `.mjs`, live in tests/site/, and need a build plus a browser, so they run as
 * their own npm scripts.
 *
 * Run: npm run test:unit
 */

import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Test files that live outside tests/ by design (they sit next to the module
// they test). build-dist.mjs keeps every *.test.js out of the published site.
const EXTRA_TESTS = ['application-script.file-size.test.js', 'assets/chat.test.js'];

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'site') continue; // browser/runtime smoke tests, run separately
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = [...(await walk(path.join(ROOT, 'tests'))), ...EXTRA_TESTS.map((f) => path.join(ROOT, f))].sort();

if (files.length === 0) {
  // A test runner that silently finds nothing is worse than a failing one.
  console.error('[run-unit-tests] FAIL: no *.test.js files found — refusing to report a vacuous pass.');
  process.exit(1);
}

console.log(`[run-unit-tests] ${files.length} test file(s)`);
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
