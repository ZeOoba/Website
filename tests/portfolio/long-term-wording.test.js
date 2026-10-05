'use strict';
// Gabriel, 2026-10-05: Oxford has sold assets (Fairground is a "Realized" case study), so the
// site must not say any building is held "permanently" or for a "40-year hold". The CAPITAL
// claim is different and stays: "permanent capital" means no fund term and no forced exit.
// This pins the asset-level wording; it deliberately does not ban "permanent capital" or the
// About page's stated 40-year planning horizon.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', 'evals', 'data', 'netlify', '.git', '.claude']);
function htmlFiles(dir = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...htmlFiles(rel)); }
    else if (e.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

test('no page, data file or prompt claims a building is held as a "permanent holding" or a "generational, 40-year hold"', () => {
  const files = [
    ...htmlFiles(),
    'data/portfolio.json',
    'scripts/build-portfolio.mjs',
    'scripts/meta.md',
    'llms.txt',
    'netlify/edge-functions/chat.ts',
  ];
  assert.ok(files.length > 40, 'file scan is broken');
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /permanent holdings?/i, `${f} calls a holding "permanent"`);
    assert.doesNotMatch(src, /generational,? 40-year hold/i, `${f} claims a generational 40-year hold`);
  }
});

test('the replacement wording is in place, and the capital claim is kept', () => {
  const portfolio = JSON.parse(read('data/portfolio.json'));
  const redBranch = portfolio.find((a) => /9050 Red Branch/i.test(a.name));
  assert.ok(redBranch, '9050 Red Branch not found');
  assert.match(redBranch.thesis, /held for the long term\.$/);
  assert.match(redBranch.detail.summary[0], /has owned and operated it since\.$/);
  for (const a of portfolio.filter((x) => x.detail && x.detail.highlights.some((h) => /Long-term hold/.test(h)))) {
    assert.ok(a.detail.highlights.includes('Long-term hold with proprietary capital'), `${a.name}: highlight wording`);
  }
  assert.match(read('scripts/build-portfolio.mjs'), /holds its properties for the long term\./);

  // Home FAQ: visible answer and FAQPage JSON-LD carry the same sentence, once each.
  const home = read('index.html');
  const sentence = 'Properties are acquired to be held for the long term rather than for a scheduled disposition.';
  assert.strictEqual(home.split(sentence).length - 1, 2, 'visible FAQ answer and its JSON-LD must both carry the sentence');
  assert.match(home, /Oxford is a permanent-capital buyer, not a fund with a defined exit timeline\./, 'the capital claim must stay');
});
