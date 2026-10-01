#!/usr/bin/env node
// Mutation tests for the site checks: `npm run test:mutation [-- options]`.
//
// A test suite that passes proves nothing until you have seen it fail on the
// breakage it exists to catch. This runner copies the repo to a temp dir,
// builds it, confirms every check is green on the unmodified copy, then applies
// each case in cases.mjs one at a time and requires the named check to fail
// (or, for legitimate variants, to keep passing). The checkout itself is never
// written.
//
// Options:
//   --only <regex>        run only cases whose id or description matches
//   --require-rendered    treat skipped browser cases as a failure (CI)
//   --keep                leave the temp copy behind for inspection
//
// Browser cases (`nav`) need the `playwright` package. Without it they are
// SKIPPED and counted, never passed silently. To drive an installed browser
// with a separately installed playwright-core, set
// MUTATION_PLAYWRIGHT_CORE=<path to its package dir> and PW_CHANNEL=msedge
// (or chrome).
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, readdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASES, VALIDATOR_CASES } from './cases.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const onlyAt = args.indexOf('--only');
const ONLY = onlyAt >= 0 ? new RegExp(args[onlyAt + 1], 'i') : null;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ora-mutation-'));
const COPY = path.join(TMP, 'site');

// --- copy -----------------------------------------------------------------------
const SKIP = /^[\\/]?(node_modules|\.git|\.claude|dist)([\\/]|$)/;
// Node 20 on Windows hands the filter extended-length paths (\\?\C:\...); Node 24
// does not. Slicing at ROOT.length then cut in the wrong place, so node_modules was
// copied and the link below failed with EEXIST. Strip the prefix, then take the
// path relative to ROOT.
const rel = (s) => path.relative(ROOT, s.replace(/^\\\\\?\\/, ''));
cpSync(ROOT, COPY, { recursive: true, filter: (s) => !SKIP.test(rel(s)) });

// node_modules: link it rather than copy it. With MUTATION_PLAYWRIGHT_CORE the
// copy gets a real node_modules of per-package links plus a `playwright` shim,
// so the shim is never written into the checkout's own node_modules.
const srcModules = path.join(ROOT, 'node_modules');
const coreDir = process.env.MUTATION_PLAYWRIGHT_CORE;
const link = (target, at) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
if (coreDir) {
  const modules = path.join(COPY, 'node_modules');
  mkdirSync(modules);
  if (existsSync(srcModules)) {
    for (const name of readdirSync(srcModules)) if (name !== 'playwright' && !name.startsWith('.')) link(path.join(srcModules, name), path.join(modules, name));
  }
  const shim = path.join(modules, 'playwright');
  mkdirSync(shim);
  writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ name: 'playwright', type: 'module', main: 'index.mjs' }));
  const entry = pathToFileURL(path.join(path.resolve(coreDir), 'index.mjs')).href;
  writeFileSync(path.join(shim, 'index.mjs'), `export { chromium } from ${JSON.stringify(entry)};\n`);
} else if (existsSync(srcModules)) {
  link(srcModules, path.join(COPY, 'node_modules'));
}
const HAVE_BROWSER = existsSync(path.join(COPY, 'node_modules', 'playwright'));

// --- commands ---------------------------------------------------------------------
// --test-reporter=spec: Node 20 defaults to TAP when stdout is not a TTY, and the
// failing-test names are read from spec's "✖ name (" lines.
const test = (...files) => ['--test', '--test-reporter=spec', ...files.map((f) => `tests/site/${f}`)];
const CMDS = {
  forms: test('netlify-forms.test.mjs'),
  integ: test('site-integrity.test.mjs'),
  seo: test('seo.test.mjs', 'seo-entity.test.mjs'),
  nav: test('mobile-nav.test.mjs'),
  budget: test('upload-budget.test.mjs'),
  listings: test('listings-ui.test.mjs'),
  verify: ['scripts/verify-jsonld.mjs'],
  build: ['scripts/build-dist.mjs'],
  // probe: the build must fail AND leave no dist/ behind
  buildFailsClean: ['-e', "const r=require('child_process').spawnSync(process.execPath,['scripts/build-dist.mjs'],{encoding:'utf8'});if(r.status===0){console.error('build passed');process.exit(1)}if(require('fs').existsSync('dist')){console.error('dist left behind');process.exit(2)}"],
  // probe: the build must pass AND not ship the dot-file
  buildNoDotfile: ['-e', "require('child_process').execFileSync(process.execPath,['scripts/build-dist.mjs'],{stdio:'ignore'});if(require('fs').existsSync('dist/resources/.draft-notes')){console.error('dot-file shipped');process.exit(1)}"],
};
const run = (cmd) => {
  const r = spawnSync(process.execPath, CMDS[cmd], { cwd: COPY, encoding: 'utf8', timeout: 600_000 });
  const out = (r.stdout || '') + (r.stderr || '') + (r.error ? `\n${r.error.message}` : '');
  const failed = [...new Set([...out.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((m) => m[1]))];
  return { status: r.status, failed, out };
};

const tally = { killed: 0, survived: 0, passed: 0, wronglyFailed: 0, stale: 0, skipped: 0 };
const problem = (key, line, out) => { tally[key]++; console.log(line); if (out) console.log(out.slice(-2500)); };

// --- build + baseline ---------------------------------------------------------------
console.log(`copy: ${COPY}${HAVE_BROWSER ? '' : '  (no playwright: browser cases will be SKIPPED)'}`);
for (const step of [['scripts/build-listings.mjs', '--check'], ['scripts/build-kb.mjs'], ['scripts/build-dist.mjs']]) {
  const r = spawnSync(process.execPath, step, { cwd: COPY, encoding: 'utf8' });
  if (r.status !== 0) { console.log(`build step failed: ${step.join(' ')}\n${(r.stdout || '') + (r.stderr || '')}`); process.exit(1); }
}
let baselineBad = 0;
console.log('== baseline (unmodified copy)');
for (const cmd of ['forms', 'integ', 'seo', 'verify', ...(HAVE_BROWSER ? ['nav', 'budget', 'listings'] : [])]) {
  const r = run(cmd);
  console.log(`  ${cmd}: exit ${r.status}`);
  if (r.status !== 0) { baselineBad++; console.log(r.out.slice(-2500)); }
}
if (baselineBad) {
  console.log('\nFAIL: the baseline is red, so no mutation result would mean anything.');
  process.exit(1);
}

// --- cases ------------------------------------------------------------------------------
console.log('== mutations');
for (const c of CASES) {
  const label = `${c.id} ${c.what}`;
  if (ONLY && !ONLY.test(label)) continue;
  if (['nav', 'budget', 'listings'].includes(c.run) && !HAVE_BROWSER) { problem('skipped', `SKIPPED  ${label} (no playwright)`); continue; }
  const saved = [];
  let r;
  try {
    for (const [file, fn] of c.edits) {
      const p = path.join(COPY, file);
      const orig = existsSync(p) ? readFileSync(p, 'utf8') : null;
      const next = fn(orig);
      if (next === orig) throw new Error(`edit did not change ${file}`);
      saved.push([p, orig]);
      writeFileSync(p, next);
    }
    r = run(c.run);
  } catch (e) {
    problem('stale', `STALE    ${label}: ${e.message}`);
    continue;
  } finally {
    for (const [p, orig] of saved.reverse()) orig === null ? unlinkSync(p) : writeFileSync(p, orig);
    if (c.run.startsWith('build') || c.edits.some(([f]) => f.startsWith('scripts/'))) run('build');
  }
  const tag = `[${c.run} exit ${r.status}] failed=${JSON.stringify(r.failed)}`;
  if (c.expect === 'PASS') {
    r.status === 0 ? (tally.passed++, console.log(`PASSED   ${label} ${tag}`)) : problem('wronglyFailed', `WRONGLY FAILED ${label} ${tag}`, r.out);
  } else {
    const hit = c.expect === 'FAIL' || r.failed.some((t) => t.includes(c.expect));
    r.status !== 0 && hit ? (tally.killed++, console.log(`KILLED   ${label} ${tag}`)) : problem('survived', `SURVIVED ${label} (wanted a failure in "${c.expect}") ${tag}`, r.out);
  }
}

// --- validate-jsonld.js, directly ---------------------------------------------------------
console.log('== validate-jsonld.js on synthetic pages');
for (const [id, what, html, wantPass] of VALIDATOR_CASES) {
  const label = `${id} ${what}`;
  if (ONLY && !ONLY.test(label)) continue;
  const f = path.join(TMP, `${id}.html`);
  writeFileSync(f, html);
  const r = spawnSync(process.execPath, [path.join(COPY, 'scripts/validate-jsonld.js'), f], { encoding: 'utf8' });
  const ok = (r.status === 0) === wantPass;
  const tag = `[exit ${r.status}, want ${wantPass ? '0' : 'non-zero'}]`;
  if (ok) { tally[wantPass ? 'passed' : 'killed']++; console.log(`OK       ${label} ${tag}`); }
  else problem(wantPass ? 'wronglyFailed' : 'survived', `WRONG    ${label} ${tag}`, (r.stdout || '') + (r.stderr || ''));
}

// --- image-size.mjs edge cases ---------------------------------------------------------------
if (!ONLY || ONLY.test('U1 U2 image-size')) {
  console.log('== image-size.mjs');
  const { imageSize } = await import(pathToFileURL(path.join(COPY, 'tests/site/lib/image-size.mjs')).href);
  const jpgSrc = path.join(COPY, 'images/02-1100-rarig-exterior-1.jpg');
  const avifSrc = path.join(COPY, 'images/02-1100-rarig-exterior-1.avif');
  const jpg = readFileSync(jpgSrc);
  const avif = Buffer.from(readFileSync(avifSrc));
  avif.write('mif1', 8, 'ascii'); // major brand mif1; avif stays in the compatible brands
  const cases = [
    ['U1 JPEG with 0xFF fill bytes before the first marker', Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xff, 0xff]), jpg.subarray(2)]), imageSize(jpgSrc)],
    ['U2 AVIF with major brand mif1', avif, imageSize(avifSrc)],
  ];
  for (const [label, buf, want] of cases) {
    const f = path.join(TMP, 'img.bin');
    writeFileSync(f, buf);
    let got;
    try { got = imageSize(f); } catch (e) { got = { error: e.message }; }
    got.width === want.width && got.height === want.height
      ? (tally.passed++, console.log(`OK       ${label}`))
      : problem('wronglyFailed', `WRONG    ${label}: got ${JSON.stringify(got)}, want ${want.width}x${want.height}`);
  }
}

// --- summary ----------------------------------------------------------------------------------
if (!flag('--keep')) rmSync(TMP, { recursive: true, force: true });
const t = tally;
console.log(`\nkilled ${t.killed} · survived ${t.survived} · legit passed ${t.passed} · wrongly failed ${t.wronglyFailed} · stale ${t.stale} · skipped ${t.skipped}`);
const bad = t.survived + t.wronglyFailed + t.stale + (flag('--require-rendered') ? t.skipped : 0);
if (bad) {
  console.log(`FAIL: ${bad} problem(s).${t.stale ? ' STALE means a case no longer matches the site; update its anchor in tests/mutation/cases.mjs.' : ''}`);
  process.exit(1);
}
console.log(t.skipped ? 'OK, with skipped browser cases (install playwright, or see MUTATION_PLAYWRIGHT_CORE).' : 'OK: every mutation killed, every legitimate variant passes.');
