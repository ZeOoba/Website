// /contact was flagged thin by the 2026-10-05 crawl (291 words). The "What to expect"
// section adds substance using only claims the site already makes elsewhere, so this
// test pins both: the section exists, the page clears the thin-content bar, and the
// claims in it match the canonical wording (nothing new, nothing contradicting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'contact.html'), 'utf8').replace(/\r\n/g, '\n');
const main = html.match(/<main id="main-content">([\s\S]*?)<\/main>/)[1];
// The crawler's word count is the whole page's visible text (nav and footer included).
const visible = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ');
const section = (main.match(/<section[^>]*aria-label="What to expect"[\s\S]*?<\/section>/) || [''])[0];
const sectionText = section.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ');

test('contact has a What to expect section with one block per audience', () => {
  assert.ok(section, 'section aria-label="What to expect" missing');
  assert.match(section, /<h2[^>]*>What to expect<\/h2>/);
  for (const h of ['Selling or submitting a deal', 'What we buy', 'Leasing']) {
    assert.match(section, new RegExp(`<h3[^>]*>${h}</h3>`), `block "${h}" missing`);
  }
});

test('contact clears the thin-content bar (the crawler flags < 300 words)', () => {
  const words = visible.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 380, `only ${words} visible words on the page`);
});

test('the section uses the canonical claims and nothing the site has ruled out', () => {
  assert.match(sectionText, /\$1M.{1,8}\$10M/, 'deal-size claim missing');
  assert.match(sectionText, /under 50,000 SF/);
  assert.match(sectionText, /30.{1,3}45 days/, 'canonical close-speed claim missing');
  assert.match(sectionText, /Maryland/);
  assert.match(sectionText, /Columbus/);
  assert.doesNotMatch(sectionText, /all-cash|all cash/i, 'the all-cash claim is under review; do not add it here');
  assert.doesNotMatch(sectionText, /Indianapolis/i);
});

test('the section does not restate the header promise or the Faster Routes list', () => {
  assert.doesNotMatch(sectionText, /one business day/i, 'the header already promises one business day');
  assert.doesNotMatch(sectionText, /OM &amp; rent roll|Owner intake|Tenant resources/);
});
