#!/usr/bin/env node
"use strict";

/**
 * postinstall hook (OI-007, 2026-07-17): rewrites node_modules/.bin/netlify(.cmd/.ps1) --
 * npm-generated shims that otherwise invoke node_modules/netlify-cli/bin/run.js directly
 * -- to invoke scripts/netlify-guard.js instead, which performs the outbound-action
 * authorization check before forwarding to the real CLI.
 *
 * WHY A POSTINSTALL PATCH, NOT A ONE-TIME EDIT: npm regenerates node_modules/.bin/*
 * shims on every `npm install`/`npm ci` from its own template -- a manual edit to them
 * is wiped the next time anyone installs. This script re-applies the redirect every
 * time, so it survives `rm -rf node_modules && npm ci` exactly like any other
 * postinstall-managed patch (the same pattern as patch-package).
 *
 * Failure mode: if a shim is missing (a future npm/netlify-cli version changes shim
 * generation, or this runs before netlify-cli is actually installed), this WARNS and
 * skips that shim rather than throwing -- a failed npm install would block every
 * developer's setup, which is a worse outcome than one shim staying unpatched. See
 * netlify-guard.js's own docstring for the runtime authorization logic this shim
 * redirect exists to reach.
 */

const fs = require("fs");
const path = require("path");

// Overridable only for the regression test (tests/site/netlify-shim-patch.test.mjs),
// which points this at a disposable fixture directory instead of the real node_modules
// so it can safely reproduce the POSIX-symlink corruption bug against a throwaway target.
const BIN_DIR = process.env.PATCH_NETLIFY_SHIM_BIN_DIR_OVERRIDE ||
  path.join(__dirname, "..", "node_modules", ".bin");
const GUARD_RELATIVE = "..\\..\\scripts\\netlify-guard.js";
const GUARD_RELATIVE_POSIX = "../../scripts/netlify-guard.js";

const SHIMS = {
  "netlify.cmd": `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${GUARD_RELATIVE}" %*
`,
  "netlify": `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=\`cygpath -w "$basedir"\`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${GUARD_RELATIVE_POSIX}" "$@"
else
  exec node  "$basedir/${GUARD_RELATIVE_POSIX}" "$@"
fi
`,
  "netlify.ps1": `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/${GUARD_RELATIVE_POSIX}" $args
  } else {
    & "$basedir/node$exe"  "$basedir/${GUARD_RELATIVE_POSIX}" $args
  }
  $ret=$LASTEXITCODE
} else {
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/${GUARD_RELATIVE_POSIX}" $args
  } else {
    & "node$exe"  "$basedir/${GUARD_RELATIVE_POSIX}" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`,
};

function patchOne(name, content) {
  const target = path.join(BIN_DIR, name);
  try {
    // CI bug (2026-09-06, caught by the first CI run ever to invoke the real CLI on
    // Linux): npm's default POSIX bin-linking makes node_modules/.bin/<name> a SYMLINK
    // into node_modules/netlify-cli/bin/run.js -- it only ever generates a standalone
    // file on Windows. fs.writeFileSync on a symlink path follows the link and writes
    // THROUGH it, silently clobbering the real netlify-cli entry point with this shim's
    // own content instead of replacing the symlink. That corrupted run.js so badly
    // `node run.js` became a syntax error, and the guard itself was never actually
    // installed (the symlink still pointed at now-garbage run.js, not at this shim).
    // rm the directory entry first -- unlink/rm never follows a symlink -- so the write
    // always creates a fresh, non-symlinked file regardless of platform or prior state.
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, content, { encoding: "utf8" });
    try { fs.chmodSync(target, 0o755); } catch (e) { /* best-effort on non-POSIX filesystems */ }
    console.log("[patch-netlify-shim] patched " + name + " -> scripts/netlify-guard.js");
    return true;
  } catch (e) {
    console.error("[patch-netlify-shim] could not patch " + name + ": " + e.message);
    return false;
  }
}

function main() {
  // FAIL THE INSTALL, not just warn (adversarial review, 2026-07-17 -- CONFIRMED
  // MEDIUM bug, fixed here): the original version warned and exited 0 whether zero, one,
  // or all three shims patched -- `npm install`/`npm ci` reported full success either
  // way, with only a warn-level console line (easy to miss in CI output, and nothing
  // machine-checkable) distinguishing "guarded" from "the real netlify binary is
  // silently intact and unguarded". A postinstall hook that can silently fail to
  // establish the guard it exists to establish is worse than no hook at all -- it gives
  // a false sense of security. Every failure mode below now exits non-zero instead.
  if (!fs.existsSync(BIN_DIR)) {
    console.error("[patch-netlify-shim] FATAL: " + BIN_DIR + " does not exist -- netlify-cli " +
      "did not install its bin directory. The netlify CLI would be UNGUARDED. Failing the " +
      "install rather than silently succeeding unguarded.");
    process.exit(1);
  }

  const names = Object.keys(SHIMS);
  const existing = names.filter((name) => fs.existsSync(path.join(BIN_DIR, name)));
  for (const name of names) {
    if (existing.indexOf(name) === -1) {
      console.warn("[patch-netlify-shim] " + name + " does not exist in this install -- " +
        "skipping (platform-specific shim variant not generated here)");
    }
  }
  if (existing.length === 0) {
    console.error("[patch-netlify-shim] FATAL: none of netlify/netlify.cmd/netlify.ps1 exist -- " +
      "netlify-cli did not generate any bin shim. The netlify CLI would be UNGUARDED. Failing " +
      "the install rather than silently succeeding unguarded.");
    process.exit(1);
  }

  const patchedCount = existing.filter((name) => patchOne(name, SHIMS[name])).length;
  if (patchedCount < existing.length) {
    console.error("[patch-netlify-shim] FATAL: " + (existing.length - patchedCount) + " of " +
      existing.length + " existing shim(s) failed to patch. The netlify CLI would be " +
      "PARTIALLY unguarded. Failing the install rather than silently succeeding that way.");
    process.exit(1);
  }
  console.log("[patch-netlify-shim] all " + patchedCount + " shim(s) patched successfully -- " +
    "netlify CLI is guarded for this install.");
}

main();
