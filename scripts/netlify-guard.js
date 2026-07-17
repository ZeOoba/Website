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
const DRY_RUN = process.env.NETLIFY_GUARD_DRY_RUN === "1";

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

function main() {
  const args = process.argv.slice(2);
  // Substring match on the JOINED, lowercased argv, not an exact-element array check
  // (adversarial review, 2026-07-17 -- CONFIRMED CRITICAL BUG, fixed here): the original
  // `args.indexOf("--prod") !== -1` requires "--prod" as its OWN argv element, so
  // `--prod=true` and `--prod-if-unlocked` -- both real netlify-cli flags, the latter
  // straight from netlify's own CLI docs, not a contrived edge case -- never matched,
  // and the authorization check was never even invoked: a real prod deploy reached
  // spawnSync with zero authorization. Mirrors ora-autonomy-gate.py's own Gate 2a
  // philosophy exactly (`"deploy" in lowered and "--prod" in lowered`, a substring check
  // over the whole command): broad match, false positive costs a retry, false negative
  // deploys unauthorized to the live site.
  const argsJoined = args.join(" ").toLowerCase();
  const isDeploy = argsJoined.indexOf("deploy") !== -1;
  const isProd = argsJoined.indexOf("--prod") !== -1;

  if (!(isDeploy && isProd)) {
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
    const output = execFileSync(process.env.PYTHON || "python",
      [CHECK_SCRIPT, "--session", sessionId],
      { encoding: "utf8" });
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

main();
