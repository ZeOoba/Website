const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const load = () => import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'scripts', 'run-site-tests.mjs')).href);

function fixture(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-tests-'));
  fs.mkdirSync(path.join(root, 'tests', 'site'), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(root, 'tests', 'site', n), '');
  return root;
}

test('lists every tests/site/*.test.mjs except the separately-run four, sorted', async () => {
  const { listSiteTests } = await load();
  const root = fixture(['b.test.mjs', 'a.test.mjs', 'leak-gate.test.mjs', 'functions-smoke.test.mjs',
    'netlify-guard.test.mjs', 'netlify-shim-patch.test.mjs', 'helper.mjs', 'x.test.js']);
  assert.deepStrictEqual(await listSiteTests(root), ['tests/site/a.test.mjs', 'tests/site/b.test.mjs']);
});

test('real repo: discovers the browser suite and none of the separate four', async () => {
  const { listSiteTests, SEPARATE } = await load();
  const files = await listSiteTests(path.join(__dirname, '..'));
  assert.ok(files.includes('tests/site/csp-smoke.test.mjs'));
  for (const s of SEPARATE) assert.ok(!files.includes(`tests/site/${s}`), s);
});
