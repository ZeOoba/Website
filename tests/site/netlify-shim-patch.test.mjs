// Regression test for a CI-only bug (2026-09-06): patch-netlify-shim.js patches
// node_modules/.bin/netlify to redirect through netlify-guard.js. On POSIX, npm's
// default bin-linking makes that path a SYMLINK into node_modules/netlify-cli/bin/run.js
// -- npm only ever generates a standalone file there on Windows. A plain
// fs.writeFileSync on a symlink path follows the link and writes THROUGH it, silently
// clobbering the real CLI entry point instead of replacing the symlink. That went
// undetected because nothing had ever actually invoked the real CLI on Linux until
// this repo's own functions-smoke test did, on the very first CI run of this pipeline.
//
// This test reproduces the exact symlink shape against a disposable fixture directory
// (never the real node_modules) and asserts the patch script leaves the "real" target
// file untouched -- it must remove the directory entry before writing, never write
// through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PATCH_SCRIPT = path.join(ROOT, 'scripts', 'patch-netlify-shim.js');
const REAL_ENTRY_POINT_SENTINEL = '#!/usr/bin/env node\nconsole.log("real netlify-cli entry point -- must survive patching");\n';

test('patch-netlify-shim does not corrupt the real CLI entry point through a POSIX bin symlink', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'netlify-shim-patch-test-'));
  const binDir = path.join(fixtureRoot, 'node_modules', '.bin');
  const cliDir = path.join(fixtureRoot, 'node_modules', 'netlify-cli', 'bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(cliDir, { recursive: true });

  const realEntryPoint = path.join(cliDir, 'run.js');
  writeFileSync(realEntryPoint, REAL_ENTRY_POINT_SENTINEL, 'utf8');

  const symlinkTarget = path.join(binDir, 'netlify');
  try {
    // npm's real POSIX behavior: node_modules/.bin/<name> is a relative symlink into
    // the package's own bin script -- reproduce that shape exactly.
    symlinkSync(path.join('..', 'netlify-cli', 'bin', 'run.js'), symlinkTarget);
  } catch (e) {
    // Creating symlinks needs a privilege this sandbox/CI runner may not grant
    // (most commonly Windows without Developer Mode). Skip rather than false-fail --
    // this test only proves something about POSIX symlink semantics.
    t.skip(`cannot create a symlink in this environment: ${e.message}`);
    rmSync(fixtureRoot, { recursive: true, force: true });
    return;
  }

  try {
    const result = spawnSync(process.execPath, [PATCH_SCRIPT], {
      env: { ...process.env, PATCH_NETLIFY_SHIM_BIN_DIR_OVERRIDE: binDir },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `patch script should exit 0; stderr:\n${result.stderr}`);

    const realEntryPointContent = readFileSync(realEntryPoint, 'utf8');
    assert.equal(
      realEntryPointContent,
      REAL_ENTRY_POINT_SENTINEL,
      'the real netlify-cli/bin/run.js must be byte-identical after patching -- ' +
        'the patch must only ever replace the .bin/netlify symlink, never write through it',
    );

    const shimContent = readFileSync(symlinkTarget, 'utf8');
    assert.match(
      shimContent,
      /netlify-guard\.js/,
      '.bin/netlify must now be the guard-redirecting shim, not the untouched symlink',
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
