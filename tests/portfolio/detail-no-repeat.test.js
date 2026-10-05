// A property page states each fact once. The hero carries location, size and type;
// "At a glance" carries market, acquisition and status; the specs table carries the
// physical facts; the "About" prose carries only what neither of those says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const portfolio = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'portfolio.json'), 'utf8'));
const withDetail = portfolio.filter((a) => a.detail);
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const page = (a) => fs.readFileSync(path.join(ROOT, 'properties', `${slug(a.name)}.html`), 'utf8').replace(/\r\n/g, '\n');

// A measured quantity: 1,800 SF, 2.35 acres, 15%, 16', 22-foot. Years, suite numbers
// and "Building C" are labels, not quantities.
const quantities = (s) => (s.match(/\d[\d,.]*(?:\s?(?:SF|acres?|%)|'|-foot)/gi) || []).map((q) => q.replace(/\s/g, '').toLowerCase());

test('no highlights list: it only restated the summary and the specs', () => {
  for (const a of withDetail) {
    assert.equal(a.detail.highlights, undefined, `${a.name}: detail.highlights must not exist`);
    assert.doesNotMatch(page(a), /pf-detail__highlights/, `${a.name}: highlights list rendered`);
  }
});

test('"At a glance" does not repeat the hero (location, size, type)', () => {
  for (const a of withDetail) {
    const glance = page(a).match(/<section class="pf-detail__facts"[\s\S]*?<\/section>/)[0];
    for (const label of ['Location', 'Size', 'Property type']) {
      assert.doesNotMatch(glance, new RegExp(`<dt>${label}</dt>`), `${a.name}: glance repeats ${label}`);
    }
    assert.match(glance, /<dt>Market<\/dt>/, `${a.name}: glance keeps Market`);
  }
});

test('the summary never restates the hero, and no quantity appears in two places', () => {
  for (const a of withDetail) {
    const summary = a.detail.summary.join(' ');
    const sf = a.sf.toLocaleString('en-US');
    assert.ok(!summary.includes(`${sf} SF`), `${a.name}: summary repeats the building SF`);
    assert.ok(!summary.includes(a.city), `${a.name}: summary repeats the city`);
    assert.ok(!summary.toLowerCase().includes(a.type.toLowerCase()), `${a.name}: summary repeats the property type`);
    if (a.acquired) assert.doesNotMatch(summary, /\b(?:19|20)\d{2}\b/, `${a.name}: summary states a date; the acquisition date is in At a glance`);

    const seen = new Map();
    const rows = [...a.detail.specs.map(([k, v]) => [`spec:${k}`, v]), ['summary', summary]];
    for (const [where, text] of rows) {
      for (const q of new Set(quantities(text))) {
        assert.ok(!seen.has(q), `${a.name}: "${q}" appears in both ${seen.get(q)} and ${where}`);
        seen.set(q, where);
      }
    }
    const values = a.detail.specs.map(([, v]) => v.toLowerCase());
    assert.equal(new Set(values).size, values.length, `${a.name}: two spec rows have the same value`);
  }
});

test('the capital claim stays on the pages that carried it', () => {
  for (const name of [/9050 Red Branch/i, /1900 North Broadway/i]) {
    const a = withDetail.find((x) => name.test(x.name));
    assert.match(a.detail.summary.join(' '), /long-term hold with proprietary capital/i, `${a.name}`);
  }
});
