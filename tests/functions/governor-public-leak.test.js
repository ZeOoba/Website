'use strict';
// Public-surface leak test for ORA's non-public underwriting figures (Invariant 4 governors and the internal
// Buy Box scorecard).
//
// This repo is PUBLIC. scripts/meta.md says no numeric leverage (LTV) figure is public and that the internal
// coverage floors and leverage ceilings are not disclosed. Two leaks of that class were found by the
// 2026-11-23 audit:
//   1. evals/results-2026-04-25T*.json transcribed live chat answers that stated a numeric DSCR floor and LTV
//      figures. They were moved to a private archive and evals/results-*.json is now gitignored.
//   2. A provenance comment in broker-score-constants.js restated the internal Buy Box rev 1.1 category weights.
// The values are still in git history from before 2026-11-23; this test stops them coming BACK into the tree or
// the built site. It is pattern-based, so it never needs (or prints) the real figures.
//
// Scope: every tracked or untracked-but-not-ignored file, plus dist/ when it exists. tests/ is skipped (fixtures
// legitimately carry synthetic numbers), as is this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');

function listSurfaceFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  const files = out.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
  const dist = path.join(ROOT, 'dist');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [path.relative(ROOT, full).split(path.sep).join('/')];
  });
  if (fs.existsSync(dist)) files.push(...walk(dist));
  return [...new Set(files)];
}

function readText(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

// A coverage term near a ratio figure ("DSCR of 1.30x", "DSCR: 1.30", "1.3 times debt service coverage").
// The window crosses periods and newlines on purpose: "(min. 1.3x)", or a term and its figure in adjacent
// table cells of built HTML.
const NEAR = String.raw`[\s\S]{0,60}?`;
const COVERAGE_TERM = String.raw`(?:(?<![a-z])dscr(?![a-z])|debt[\s_-]+service[\s_-]+coverage|coverage[\s_-]+(?:ratio|floor|minimum)|coverage\s+of)`;
const RATIO = String.raw`(?:\b\d(?:\.\d{1,2})?\s*(?:[x×]|&times;|&#215;|times)(?![a-z0-9])|(?<![\d.])[0-4]\.\d{1,2}(?![\d.%]))`;
// A leverage term near a percentage or a fraction ("LTV of 55%", "55 percent leverage", "LTV: 0.55").
const LEVERAGE_TERM = String.raw`(?:(?<![a-z])ltv(?![a-z])|loan[\s_-]+to[\s_-]+value|\bleverage\b)`;
const PERCENT = String.raw`(?:\b\d{1,2}(?:\.\d+)?\s*(?:%|&#37;|&percnt;|％|percent\b|pct\b)|(?<![\d.])0?\.\d{1,2}(?![\d.%]))`;

const RULES = [
  ['numeric coverage (DSCR) figure', new RegExp(`${COVERAGE_TERM}${NEAR}${RATIO}|${RATIO}${NEAR}${COVERAGE_TERM}`, 'i')],
  ['numeric leverage (LTV) figure', new RegExp(`${LEVERAGE_TERM}${NEAR}${PERCENT}|${PERCENT}${NEAR}${LEVERAGE_TERM}`, 'i')],
  // Three or more "Category NN" entries joined by "/" or "·": how the internal scorecard weights were written
  // out ("A 25 / B 20 / C 20", "A: 25/B: 20/C: 20", "Two Words (25) · B 20% · C 20"). The site scorecard's own
  // weights live in an object literal (broker-score-constants.js), never in this form. Comma-separated lists
  // are deliberately NOT matched: they are ordinary copy ("Columbus 12, Dayton 4, ...").
  ['scorecard weight sequence', (() => {
    const entry = String.raw`[A-Z][A-Za-z-]+(?: [A-Z][A-Za-z-]+)?:?\s*\(?\d{1,2}%?\)?`;
    const sep = String.raw`\s*(?:\/|·|&middot;)\s*`;
    return new RegExp(`\\b${entry}${sep}${entry}${sep}${entry}`);
  })()],
];

function findings(text) {
  return RULES.filter(([, re]) => re.test(text)).map(([kind]) => kind);
}

test('no numeric governor figure or internal scorecard weighting on the public surface (tree + dist/)', () => {
  const offenders = [];
  for (const rel of listSurfaceFiles()) {
    if (rel.startsWith('tests/') || rel === SELF) continue;
    const text = readText(rel);
    if (text == null) continue;
    for (const kind of findings(text)) offenders.push(`${rel}: ${kind}`);
  }
  assert.deepEqual(offenders, [], 'Non-public underwriting figures belong in no tracked file or built page (scripts/meta.md). '
    + 'Remove them; for chat eval output, keep evals/results-*.json untracked.');
});

test('chat eval output is gitignored, so a run cannot be committed by accident', () => {
  const probe = 'evals/results-2099-01-01T00-00-00-000Z.json';
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', '--no-index', probe], { cwd: ROOT }); } catch { ignored = false; }
  assert.ok(ignored, `${probe} must match a .gitignore rule (scripts/eval-chat.mjs writes there)`);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/eval-chat.mjs'), 'utf8'), /'evals',\s*`results-\$\{ts\}\.json`/,
    'scripts/eval-chat.mjs changed its output path; move the .gitignore rule with it');
});

test('the rules catch the leak shapes and leave ordinary copy alone', () => {
  // Invented figures; never use a real governor value as an example (this repo is public).
  const leaks = [
    'ORA underwrites to a minimum 9.99x debt service coverage ratio.',
    'targets a **DSCR ≥ 7.5×** with conservative leverage',
    'conservative leverage (11% portfolio LTV, 22% max)',
    '33% loan-to-value on each asset',
    'scorecard (Alpha 30 / Beta 20 / Gamma 10 / Delta 5)',
    'DSCR: 3.87',
    'DSCR minimum 3.21 on every loan',
    'debt service coverage of at least 2.2',
    'coverage of 3.3 times',
    'DSCR (min. 4.4x)',
    'LTV (e.g. 44.4%)',
    '<th>DSCR</th>\n  <td>2.75&times;</td>',
    '<th>Max LTV</th>\n<td>44%</td>',
    'LTV 33&#37;',
    '22 percent leverage',
    'LTV: 0.44',
    '"ltv": 0.3,',
    'min_dscr = 2.5x',
    'Alpha 30/Beta 20/Gamma 10',
    'Alpha: 30 / Beta: 20 / Gamma: 10',
    'Two Words (30) · Beta 20% · Gamma 10',
  ];
  for (const s of leaks) assert.ok(findings(s).length > 0, s);
  const clean = [
    'lenders require DSCR coverage that vacant properties cannot generate.',
    'DSCR fails loan sizing',
    'Do not state a numeric LTV or leverage percentage; describe it only as conservative.',
    'Clear heights of 14-24 ft, 3x dock doors.',
    'Occupancy is 100% and leverage is conservative. The roof is 20 years old.',
    'weights: { dealSize: 25, basis: 25, buildingSize: 20 }',
    'Columbus 12, Dayton 4, Indianapolis 3',
    'Built 2004, leverage is conservative, 6 docks and 3 drive-ins.',
  ];
  for (const s of clean) assert.deepEqual(findings(s), [], s);
});
