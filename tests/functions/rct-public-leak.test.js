'use strict';
// Public-surface leak test for the RCT replacement-cost table (governor-level, ratified by Gabriel).
//
// This repo is PUBLIC, so the table lives only in the RCT_BENCHMARK_JSON Netlify env var
// (netlify/functions/_shared/rct-benchmark.js, docs/rct-benchmark-config.md). The values are still in git
// history from before 2026-11-13; this test stops them coming BACK into the tree or the built site.
//
// Two layers:
//   1. Structural checks that always run (CI included): the old in-repo copy is gone, and no non-test
//      source carries a literal marketToRctLowPerSF table.
//   2. A value scan that needs the REAL table, which is never committed: it reads RCT_BENCHMARK_JSON, or the
//      gitignored /.rct-benchmark.local.json (create it with `netlify env:get RCT_BENCHMARK_JSON >
//      .rct-benchmark.local.json`). Without either it SKIPS and says so. It scans every tracked or
//      untracked-but-not-ignored file plus dist/ for the LOW $/SF figures, and for files naming two or more of
//      the table's non-portfolio (entry) markets together. It never prints a figure, only the file and kind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateRctBenchmark } = require('../../netlify/functions/_shared/rct-benchmark.js');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_FILE = path.join(ROOT, '.rct-benchmark.local.json');
// Markets already public on the site (portfolio and listings pages): naming them is not a disclosure.
const PUBLIC_MARKETS = new Set(['Maryland', 'Columbus', 'Kansas City', 'Indianapolis']);
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

function loadRealTable() {
  const fromEnv = process.env.RCT_BENCHMARK_JSON;
  let raw = null;
  let source = null;
  if (typeof fromEnv === 'string' && fromEnv.trim()) { raw = fromEnv; source = 'RCT_BENCHMARK_JSON'; }
  else if (fs.existsSync(LOCAL_FILE)) { raw = fs.readFileSync(LOCAL_FILE, 'utf8'); source = '.rct-benchmark.local.json'; }
  if (!raw) return { skip: 'no real RCT table available (set RCT_BENCHMARK_JSON or create the gitignored .rct-benchmark.local.json)' };
  let table;
  try { table = JSON.parse(raw.replace(/^﻿/, '')); } catch { return { error: `${source} is not valid JSON` }; }
  if (table && table.rctVersion === 'synthetic-test-fixture') return { skip: `${source} holds the synthetic fixture, not the real table` };
  // Schema only, not the hash pin: a stale local copy from an earlier ratification is still worth scanning for.
  const bad = validateRctBenchmark(table, { pinnedHmac: null });
  if (bad) return { error: `${source} ${bad}` };
  return { table, source };
}

function figureRegex(n) {
  // 123.4 must match "123.4" and "123.40" but not "1123.4", "123.45" or "123.401".
  const [int, frac = ''] = n.toFixed(2).split('.');
  const trimmed = frac.replace(/0+$/, '');
  const fracPart = trimmed ? `\\.${trimmed}0*` : '(?:\\.0+)?';
  return new RegExp(`(?<![\\d.])${int}${fracPart}(?![\\d])`);
}

test('the old in-repo copy of the RCT table is gone', () => {
  for (const f of ['netlify/functions/_shared/rct-benchmark.json', 'netlify/functions/_shared/rct-benchmark-data.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} must not exist: the RCT table is runtime config (RCT_BENCHMARK_JSON)`);
  }
});

test('no non-test source carries a literal marketToRctLowPerSF table', () => {
  const offenders = [];
  for (const rel of listSurfaceFiles()) {
    if (rel.startsWith('tests/') || rel === SELF) continue;
    const text = readText(rel);
    if (text == null) continue;
    // A key followed by an object literal that contains a number: the table itself, not a reference to it.
    if (/"?marketToRctLowPerSF"?\s*:\s*\{[^}]*\d/.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'RCT figures belong only in the RCT_BENCHMARK_JSON env var (docs/rct-benchmark-config.md)');
});

test('the real RCT figures and entry-market list appear nowhere on the public surface (tree + dist/)', (t) => {
  const loaded = loadRealTable();
  if (loaded.skip) { t.skip(loaded.skip); return; }
  assert.equal(loaded.error, undefined, loaded.error);
  const { table } = loaded;
  const figures = [...new Set(Object.values(table.marketToRctLowPerSF))].map((n) => figureRegex(n));
  const entryMarkets = Object.keys(table.marketToRctLowPerSF).filter((m) => !PUBLIC_MARKETS.has(m));
  // The vintage ramp's figures are common numbers on their own (years, percentages), so it counts as leaked
  // only when one object literal carries all four ratified values.
  const vf = table.vintageFloor;
  const ramp = [['earlyYear', vf.earlyYear], ['earlyPct', vf.earlyPct], ['lateYear', vf.lateYear], ['latePct', vf.latePct]];
  const rampLeaked = (text) => {
    for (const m of text.matchAll(/\{[^{}]*\bearlyYear\b[^{}]*\}/g)) {
      if (ramp.every(([k, v]) => new RegExp(`\\b${k}"?\\s*:\\s*${figureRegex(v).source}`).test(m[0]))) return true;
    }
    return false;
  };
  const findings = [];
  for (const rel of listSurfaceFiles()) {
    const text = readText(rel);
    if (text == null) continue;
    const hits = figures.filter((re) => re.test(text)).length;
    if (hits > 0) findings.push(`${rel}: ${hits} RCT LOW $/SF figure(s)`);
    if (rampLeaked(text)) findings.push(`${rel}: the ratified vintage-floor ramp`);
    const named = entryMarkets.filter((m) => text.includes(m));
    if (named.length >= 2) findings.push(`${rel}: names ${named.length} entry markets from the RCT table together`);
  }
  assert.deepEqual(findings, [], `RCT table leaked into the public surface (values from ${loaded.source}). Remove it; never commit the figures.`);
});

// The HMAC pin is only safe while its key stays secret: a committed key makes the published pin brute-forceable
// again (round-2 adversarial review). Scans for the key itself when it is available locally.
test('the RCT pin key appears nowhere on the public surface (tree + dist/)', (t) => {
  const keyFile = path.join(ROOT, '.rct-benchmark-pin-key.local');
  const fromEnv = process.env.RCT_BENCHMARK_PIN_KEY;
  const key = (typeof fromEnv === 'string' && fromEnv.trim()) ? fromEnv.trim()
    : (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
  if (!key) { t.skip('no pin key available (set RCT_BENCHMARK_PIN_KEY or create the gitignored .rct-benchmark-pin-key.local)'); return; }
  const probe = key.slice(0, 24); // a long prefix is enough and keeps the full key out of any diff output
  const offenders = listSurfaceFiles().filter((rel) => { const text = readText(rel); return text != null && text.includes(probe); });
  assert.deepEqual(offenders, [], 'the RCT_BENCHMARK_PIN_KEY value leaked into the public surface. Remove it and rotate the key.');
});

test('figureRegex matches the figure in either format and nothing adjacent', () => {
  // Invented figure; never use a real RCT value as an example here (this file is scanned too).
  const re = figureRegex(123.4);
  for (const s of ['123.4', '123.40', '$123.40/SF', '"x": 123.4,']) assert.ok(re.test(s), s);
  for (const s of ['1123.4', '123.45', '123.401', '2123.40', '23.4']) assert.ok(!re.test(s), s);
  assert.ok(figureRegex(200).test('200.00') && figureRegex(200).test('x 200 y') && !figureRegex(200).test('2000'));
});
