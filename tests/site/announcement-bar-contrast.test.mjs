// The announcement bar rotates every 4 s. Lighthouse/axe measure contrast on whatever
// is on screen at that instant, so an opacity cross-fade is sampled mid-fade and the bar
// fails "Background and foreground colors do not have a sufficient contrast ratio" at
// random (PageSpeed Accessibility 97, 2026-10-05). The items swap instantly instead:
// the active one is always opacity 1, the others opacity 0, nothing in between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = ['styles.css', ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')), ...['properties', 'markets', 'resources'].flatMap((d) => fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.html')).map((f) => `${d}/${f}`) : [])];

test('no page or stylesheet fades the announcement-bar items', () => {
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const rules = src.match(/\.announcement-bar__item\s*\{[^}]*\}/g) || [];
    for (const rule of rules) {
      checked += 1;
      assert.doesNotMatch(rule, /transition/, `${f}: ${rule} animates the item, so contrast is measured mid-fade`);
    }
  }
  assert.ok(checked > 50, `only ${checked} announcement-bar__item rules found; the file scan is broken`);
});
