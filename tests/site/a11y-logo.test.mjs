// Nav logo accessible name (axe `label-content-name-mismatch`, found by Lighthouse 2026-10-02).
//
// The logo is an SVG whose visible label is two <text> runs ("OXFORD", "Realty Advisors"). axe joins
// those runs without a space, so an aria-label on the LINK ("Oxford Realty Advisors — Home") never
// "contains" the visible text, whatever its wording: removing "— Home", changing case, or hiding the
// <text> from assistive tech all still fail. What passes (verified by running axe 4.x against each
// variant) is giving the SVG itself the accessible name and leaving the link without an aria-label:
// the link's name then comes from its content and stays exactly "Oxford Realty Advisors — Home".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['dist', 'node_modules', 'scripts', 'tests', 'evals', 'docs', 'netlify', 'data']);

function htmlFiles(dir = ROOT, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || (!rel && SKIP_DIRS.has(name))) continue;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...htmlFiles(abs, r));
    else if (name.endsWith('.html')) out.push(r);
  }
  return out;
}

// The three dash spellings in use across hand-authored pages.
const NAME = /^Oxford Realty Advisors (?:—|&#8212;|&mdash;) Home$/;
const pages = htmlFiles().filter((f) => /class="nav__logo"/.test(readFileSync(path.join(ROOT, f), 'utf8')));

test('the nav logo exists on the pages that have a header', () => {
  assert.ok(pages.length >= 20, `expected the ~21 site pages, found ${pages.length}`);
});

for (const file of pages) {
  test(`${file}: nav logo link carries no aria-label; its SVG carries the accessible name`, () => {
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    const links = [...html.matchAll(/<a\b[^>]*class="nav__logo"[^>]*>\s*(<svg\b[^>]*>)/g)];
    assert.equal(links.length, 1, 'exactly one nav logo link wrapping an <svg>');
    const [whole, svgTag] = links[0];
    const anchorTag = whole.slice(0, whole.indexOf(svgTag));
    assert.ok(!/\saria-label=/.test(anchorTag), `link must not set aria-label (axe label-content-name-mismatch): ${anchorTag}`);
    assert.match(svgTag, /\srole="img"/, 'svg must be role="img"');
    assert.ok(!/\saria-hidden=/.test(svgTag), 'svg must not be aria-hidden, or the link has no name');
    const label = /\saria-label="([^"]*)"/.exec(svgTag)?.[1] ?? '';
    assert.match(label, NAME, `svg aria-label must read "Oxford Realty Advisors — Home" (got "${label}")`);
  });
}
