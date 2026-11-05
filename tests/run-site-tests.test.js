const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const load = () => import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'scripts', 'run-site-tests.mjs')).href);

function fixture(t, names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-tests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests', 'site'), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(root, 'tests', 'site', n), '');
  return root;
}

test('lists every tests/site/*.test.mjs except the separately-run four, sorted', async (t) => {
  const { listSiteTests } = await load();
  const root = fixture(t, ['b.test.mjs', 'a.test.mjs', 'leak-gate.test.mjs', 'functions-smoke.test.mjs',
    'netlify-guard.test.mjs', 'netlify-shim-patch.test.mjs', 'helper.mjs', 'x.test.js']);
  assert.deepStrictEqual(await listSiteTests(root), ['tests/site/a.test.mjs', 'tests/site/b.test.mjs']);
});

test('real repo: discovers the browser suite and none of the separate four', async () => {
  const { listSiteTests, SEPARATE } = await load();
  const files = await listSiteTests(path.join(__dirname, '..'));
  assert.ok(files.includes('tests/site/csp-smoke.test.mjs'));
  for (const s of SEPARATE) assert.ok(!files.includes(`tests/site/${s}`), s);
});

const REPO = path.join(__dirname, '..');
const REPO_ROOT = REPO;
const SCRIPT = path.join('scripts', 'run-site-tests.mjs');
const NEWLINE = /\r?\n/;

function listVia(scriptPath) {
  return spawnSync(process.execPath, [scriptPath, '--list'], { cwd: REPO, encoding: 'utf8' });
}

test('--list matches listSiteTests() when the script is reached through a junction/symlink', async (t) => {
  const { listSiteTests } = await load();
  const expected = await listSiteTests(REPO_ROOT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-tests-link-'));
  const link = path.join(tmp, 'repo-link');
  t.after(() => {
    // Remove the junction/symlink itself first so recursive removal can never follow it into the live checkout.
    // Only "not found" (link never created) may fall through; any other unlink failure stops the cleanup
    // rather than letting rmSync meet a live junction (Windows' EPERM fallback can follow it).
    try { fs.unlinkSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  try {
    fs.symlinkSync(REPO, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    return t.skip(`cannot create junction/symlink here: ${e.code || e.message}`);
  }
  const r = listVia(path.join(link, SCRIPT));
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(NEWLINE).filter(Boolean);
  assert.ok(lines.length >= 20, `expected at least 20 site test files, got ${lines.length}: ${r.stdout}`);
  assert.deepStrictEqual(lines, expected);
});

test('--list matches listSiteTests() with a differently-cased drive letter (Windows)', async (t) => {
  if (process.platform !== 'win32') return t.skip('drive-letter casing only applies on Windows');
  const { listSiteTests } = await load();
  const expected = await listSiteTests(REPO_ROOT);
  const abs = path.resolve(REPO, SCRIPT);
  const flipped = abs[0] === abs[0].toLowerCase() ? abs[0].toUpperCase() + abs.slice(1) : abs[0].toLowerCase() + abs.slice(1);
  const r = listVia(flipped);
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(NEWLINE).filter(Boolean);
  assert.ok(lines.length >= 20, `expected at least 20 site test files, got ${lines.length}: ${r.stdout}`);
  assert.deepStrictEqual(lines, expected);
});
