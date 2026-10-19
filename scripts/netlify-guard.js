#!/usr/bin/env node
"use strict";

/**
 * OUTBOUND-ACTION check for Hard Invariant 2 (OI-007, 2026-07-17), the netlify side.
 *
 * ora-autonomy-gate.py's Gate 2a (PreToolUse, in ~/.claude) detects a prod deploy by
 * parsing the Bash command's literal TEXT. Adversarial review proved that is
 * structurally blind to value indirection: splitting `netlify deploy --prod` across two
 * Bash calls (build an executable reference in one, invoke it via that reference in a
 * second), or invoking a renamed/copied binary, reaches exit 0 unblocked -- no override
 * needed, nothing logged.
 *
 * This script closes that gap at the one point indirection cannot survive: postinstall
 * (see scripts/patch-netlify-shim.js) makes THIS script the actual thing node_modules/
 * .bin/netlify(.cmd/.ps1) invoke, in place of netlify-cli's own bin/run.js. By the time a
 * shell has genuinely launched a node process running this file, process.argv is the
 * final, resolved argument list -- there is no more indirection left to resolve, because
 * the shell already had to name a real, concrete executable and pass it real, concrete
 * arguments to get here at all.
 *
 * Defense in depth, not a replacement for Gate 2a: the PreToolUse gate still catches the
 * common literal `netlify deploy --prod` case for free, before the tool call even runs.
 * This is the backstop for the cases that survive it.
 *
 * The actual token validation is NOT reimplemented here: it shells out to
 * hooks/lib/check_website_deploy.py (via execFileSync, argv array -- not a shell string,
 * so there is no argument-marshaling risk to worry about, unlike the PowerShell/email
 * side of OI-007, which had to move off a CLI arg for exactly that reason). One
 * canonical Python implementation of the token contract; this wrapper is just a caller.
 *
 * NETLIFY_GUARD_DRY_RUN=1 performs the full check but does not exec the real netlify-cli
 * -- logs "DRY RUN: would deploy"/"DRY RUN: would run <cmd>" and exits 0 instead. Added
 * so this file's own gating logic can be tested end-to-end without ever risking an
 * actual `netlify deploy --prod` against the live site.
 */

const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const REAL_CLI_ENTRY = path.join(__dirname, "..", "node_modules", "netlify-cli", "bin", "run.js");
const CHECK_SCRIPT = "C:\\Users\\Owner\\.claude\\hooks\\lib\\check_website_deploy.py";
// Fixed absolute interpreter, never process.env.PYTHON: an env-var interpreter let any
// caller that could set a session id point the validator at `true`/`cmd.exe` and
// self-authorize. If Python moves this fails CLOSED (ENOENT -> DENIED, exit 5): update
// this constant, do not reintroduce an env/PATH lookup. Mirrors hooks/bin/netlify-guard-global.js.
const PYTHON_EXE = "C:\\Users\\Owner\\AppData\\Local\\Programs\\Python\\Python313\\python.exe";
const DRY_RUN = process.env.NETLIFY_GUARD_DRY_RUN === "1";

const VALIDATOR_ENV_ALLOWLIST = [
  "systemroot", "windir", "systemdrive", "path", "pathext", "comspec",
  "userprofile", "homedrive", "homepath", "home", "appdata", "localappdata",
  "temp", "tmp",
];

// Case-insensitive (Windows env names are), values copied verbatim, everything else dropped.
function validatorEnv() {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (VALIDATOR_ENV_ALLOWLIST.indexOf(key.toLowerCase()) !== -1) env[key] = process.env[key];
  }
  return env;
}

function log(message) {
  process.stderr.write("[netlify-guard] " + message + "\n");
}

function runRealCli(args) {
  if (DRY_RUN) {
    log("DRY RUN: would run `netlify " + args.join(" ") + "` (no real CLI invoked)");
    process.exit(0);
  }
  // spawnSync (a genuinely separate process), not require(): netlify-cli's run.js expects
  // to be the entry-point module (it likely branches on require.main === module
  // internally), so requiring it in-process would not behave like a real invocation.
  const result = spawnSync(process.execPath, [REAL_CLI_ENTRY].concat(args), { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

// Short flags of `netlify deploy` that consume a value (-d dir, -f functions, -b branch,
// -m message, -s site). In a bundle like `-sfoo` everything after one of these is that
// flag's value, not more flags, so a "p" inside it (a site named "app") is not `-p`.
const VALUE_SHORT_FLAGS = "dfbms";
// `netlify api <method>`: an ALLOWLIST of read-only methods. Every other method (restore,
// rollback, disableSite, deleteSite, updateSite, split tests, DNS, env vars, snippets,
// commits ...) can change the live site, so it goes through the authorization check.
const READ_ONLY_API_METHOD = /^(get|list|show|search)[a-z0-9]*$/i;

// Token-by-token argv parse. Long forms: --prod, --prod=true, --prod-if-unlocked and
// anything else starting with --prod; --trigger is included because it starts a build of
// the live site on Netlify without uploading local files.
function hasProdFlag(args) {
  for (const arg of args) {
    const lowered = arg.toLowerCase();
    if (lowered.indexOf("--prod") === 0 || lowered === "--trigger" || lowered.indexOf("--trigger=") === 0) {
      return true;
    }
    // Short flags: commander lets boolean shorts bundle (`-ap`, `-Op`) and accepts
    // `-p=true`. Case-sensitive on purpose (`-P` is not a flag), walked left to right.
    if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "p") return true;
        if (ch === "=" || VALUE_SHORT_FLAGS.indexOf(ch) !== -1) break;
      }
    }
  }
  return false;
}

function isProdInvocation(args) {
  // Substring match on the JOINED, lowercased argv for "deploy" (adversarial review,
  // 2026-07-17): broad match, false positive costs a retry, false negative deploys
  // unauthorized to the live site. The prod flag is parsed per token (2026-10-17): the
  // earlier `indexOf("--prod")` over the joined string missed netlify-cli's documented
  // short flag, so `netlify deploy -p` reached production with no authorization check.
  const isDeploy = args.join(" ").toLowerCase().indexOf("deploy") !== -1;
  if (isDeploy && hasProdFlag(args)) return true;
  // `netlify api restoreSiteDeploy` and friends reach production with no `deploy --prod`.
  // Candidates are the identifier-shaped non-flag tokens after `api` (JSON --data values
  // never look like identifiers); any candidate that is not a read-only method is prod.
  const apiAt = args.findIndex((a) => a.toLowerCase() === "api");
  if (apiAt !== -1) {
    return args
      .slice(apiAt + 1)
      .some((a) => /^[a-z][a-z0-9]*$/i.test(a) && !READ_ONLY_API_METHOD.test(a));
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);

  if (!isProdInvocation(args)) {
    // Every other command (dev, status, --version, a non-prod/preview deploy, ...) --
    // "Reads and preview deploys pass untouched", same philosophy as the PreToolUse gate.
    runRealCli(args);
    return;
  }

  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    // No session context = no override is reachable at all (mirrors the identical
    // fail-closed rule already used on both the doctrine gate and the email side of
    // OI-007). A genuine CI/scheduled deploy pipeline would need its own, deliberately
    // separate authorization path -- not this one, and not by accident.
    log("prod deploy attempted but no CLAUDE_CODE_SESSION_ID in environment -- " +
        "no override reachable, refusing to deploy");
    process.exit(5);
  }

  try {
    // -I (isolated): ignores PYTHON* env vars (PYTHONPATH/PYTHONSTARTUP/...) and user site.
    // env is an ALLOWLIST, not a copy of process.env: the validator reads test seams such as
    // ORA_OVERRIDE_SESSIONS_DIR (override_tokens.py) that would let a caller point it at a
    // directory holding a forged token and self-authorize. Only what Windows/Python needs is
    // passed through (the sessions dir default is an absolute path in override_tokens.py).
    // -S: no site module, so a planted sitecustomize/.pth in the user-writable site-packages
    // cannot run inside the validator.
    const output = execFileSync(PYTHON_EXE, ["-I", "-S", CHECK_SCRIPT, "--session", sessionId],
      { encoding: "utf8", env: validatorEnv() });
    log("authorized prod deploy for session " + sessionId + " -- " + output.trim());
  } catch (err) {
    // A validator we cannot run, OR a validator that explicitly denied, both mean the
    // same thing here: no authorization -> refuse. execFileSync throws on ANY non-zero
    // exit, so this branch covers "denied" and "couldn't even launch python" alike --
    // fail closed exactly like ora-autonomy-gate.py's own broken-module handling.
    const detail = (err.stderr && err.stderr.toString().trim()) || err.message;
    log("DENIED for prod deploy (session " + sessionId + ") -- " + detail);
    process.exit(5);
  }

  runRealCli(args);
}

if (require.main === module) {
  main();
} else {
  module.exports = { isProdInvocation };
}
