// Cache-busting: _headers serves every .css/.js as `max-age=31536000, immutable`, so a stale
// hand-bumped ?v= leaves returning visitors on old code for a year. The build stamps each
// same-site asset reference in dist/ with the hash of the published bytes.
// Requires `npm run build` first (the site suite's other tests also read dist/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { stampAssetVersions } from '../../scripts/stamp-asset-versions.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const sha10 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

function walkHtml(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkHtml(path.join(dir, e.name)) : e.name.endsWith('.html') ? [path.join(dir, e.name)] : []);
}

test('every same-site css/js reference in dist carries ?v=<hash of the published file>', () => {
  assert.ok(existsSync(DIST), 'dist/ missing; run npm run build first');
  const bad = [];
  let checked = 0;
  for (const file of walkHtml(DIST)) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/\b(?:href|src)=(["'])(\/[^"'?#\s]+\.(?:css|js))(\?[^"'#]*)?(?=["'#])/g)) {
      const [, , urlPath, query = ''] = m;
      if (urlPath.startsWith('/assets/partytown/')) continue; // vendored: ?v= is the upstream release
      checked++;
      const want = `?v=${sha10(readFileSync(path.join(DIST, ...urlPath.split('/').filter(Boolean))))}`;
      if (query !== want) bad.push(`${path.relative(DIST, file)}: ${urlPath}${query} (want ${want})`);
    }
  }
  assert.ok(checked > 200, `only ${checked} references checked; the scan is broken`);
  assert.deepEqual(bad, []);
});

test('stampAssetVersions rewrites stale, missing and fragment-bearing refs; fails on unknown files and odd queries', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'stamp-'));
  try {
    mkdirSync(path.join(tmp, 'assets', 'partytown'), { recursive: true });
    writeFileSync(path.join(tmp, 'a.js'), 'one');
    writeFileSync(path.join(tmp, 'a.css'), 'two');
    writeFileSync(path.join(tmp, 'assets', 'partytown', 'p.js'), 'vendor');
    const page = [
      `<link rel="preload" href="/a.css?v=3" as="style" onload="this.rel='stylesheet'">`,
      `<noscript><link rel="stylesheet" href='/a.css?v=3'></noscript>`,
      `<script src="/a.js"></script>`,
      `<script src="/a.js?v=old#x"></script>`,
      `<script src="/assets/partytown/p.js?v=0.14.4"></script>`,
      `<script src="https://cdn.example/x.js?v=1"></script>`,
    ].join('\n');
    writeFileSync(path.join(tmp, 'index.html'), page);
    assert.deepEqual(await stampAssetVersions(tmp), []);
    const out = readFileSync(path.join(tmp, 'index.html'), 'utf8');
    const js = sha10('one');
    const css = sha10('two');
    assert.ok(out.includes(`href="/a.css?v=${css}" as="style" onload="this.rel='stylesheet'"`));
    assert.ok(out.includes(`href='/a.css?v=${css}'`));
    assert.ok(out.includes(`<script src="/a.js?v=${js}"></script>`));
    assert.ok(out.includes(`<script src="/a.js?v=${js}#x"></script>`));
    assert.ok(out.includes('/assets/partytown/p.js?v=0.14.4'));
    assert.ok(out.includes('https://cdn.example/x.js?v=1'));
    // Idempotent: a second pass changes nothing.
    assert.deepEqual(await stampAssetVersions(tmp), []);
    assert.equal(readFileSync(path.join(tmp, 'index.html'), 'utf8'), out);

    writeFileSync(path.join(tmp, 'bad.html'), `<script src="/missing.js?v=1"></script><link href="/a.css?x=1" rel="stylesheet">`);
    const failures = await stampAssetVersions(tmp);
    assert.equal(failures.length, 2);
    assert.match(failures[0], /missing\.js.*not in dist/);
    assert.match(failures[1], /a\.css\?x=1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
