// Hard Invariant 2 regression test for scripts/netlify-guard.js. The guard must treat every
// spelling of "deploy to production" as production: `-p` (netlify-cli's documented short
// flag, including bundled shorts like `-ap`), `--prod`, `--prod=*`, `--prod-if-unlocked`,
// and `netlify api` publish/restore methods. With no CLAUDE_CODE_SESSION_ID the guard exits
// 5; a non-prod invocation reaches the (dry-run) CLI and exits 0. NETLIFY_GUARD_DRY_RUN=1
// means no real netlify-cli is ever launched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(__dirname, '..', '..', 'scripts', 'netlify-guard.js');

// The validator lives on Gabriel's machine (fixed interpreter + ~/.claude hook). On CI or any
// machine without both, the tests that exercise the real validator are skipped, not failed;
// the argv-classification tests below need neither.
const PYTHON_EXE = 'C:\\Users\\Owner\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
const CHECK_SCRIPT = 'C:\\Users\\Owner\\.claude\\hooks\\lib\\check_website_deploy.py';
const NEEDS_VALIDATOR = existsSync(PYTHON_EXE) && existsSync(CHECK_SCRIPT)
  ? false
  : 'validator interpreter or check_website_deploy.py not present on this machine';

function runGuard(args) {
  const env = { ...process.env, NETLIFY_GUARD_DRY_RUN: '1' };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [GUARD, ...args], { env, encoding: 'utf8' });
}

const PROD = [
  ['deploy', '-p'],
  ['deploy', '-ap'],
  ['deploy', '-Op'],
  ['deploy', '-p=true'],
  ['deploy', '--dir', 'dist', '-p'],
  ['deploy', '-m', 'msg', '-p'],
  ['deploy', '--prod'],
  ['deploy', '--PROD'],
  ['deploy', '--prod=true'],
  ['deploy', '--prod-if-unlocked'],
  ['deploy', '--trigger'],
  ['api', 'restoreSiteDeploy', '--data', '{"deploy_id":"x"}'],
  ['api', 'rollbackSiteDeploy'],
  ['api', 'createSiteDeploy'],
  ['api', 'createSiteBuild'],
  ['api', 'unlockDeploy'],
  // Non-read-only api methods (adversarial review): the api gate is an allowlist of reads.
  ['api', 'disableSite'],
  ['api', 'deleteSite'],
  ['api', 'updateSite', '--data', '{"site_id":"x","body":{"build_settings":{"cmd":"x"}}}'],
  ['api', 'enableSplitTest'],
  ['api', 'createDnsRecord'],
  ['api', 'deleteSiteDeploy'],
  ['api', 'updateSiteDeploy'],
  ['api', 'setEnvVarValue'],
  ['api', 'createSiteSnippet'],
  ['api', '--data', '{"site_id":"x"}', 'deleteSite'],
  ['api', 'deleteSite', 'listSites'],
  // bundle walk stops at "=" and at value-taking flags, but a p before them still counts
  ['deploy', '-Op=x'],
];

for (const args of PROD) {
  test(`guard treats \`netlify ${args.join(' ')}\` as production (exit 5 without a session)`, () => {
    const r = runGuard(args);
    assert.equal(r.status, 5, `expected exit 5; stderr:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /DRY RUN/, 'must be refused before reaching the CLI');
  });
}

test('a session with no valid website-deploy token is DENIED by the validator, not passed through', { skip: NEEDS_VALIDATOR }, () => {
  const env = { ...process.env, NETLIFY_GUARD_DRY_RUN: '1', CLAUDE_CODE_SESSION_ID: 'netlify-guard-test-no-such-session' };
  const r = spawnSync(process.execPath, [GUARD, 'deploy', '-p'], { env, encoding: 'utf8' });
  assert.equal(r.status, 5, `expected exit 5; stderr:\n${r.stderr}`);
  assert.match(r.stderr, /check_website_deploy: DENY/);
  assert.doesNotMatch(r.stderr, /DRY RUN/);
});

// The validator interpreter is fixed in the script. An inherited PYTHON env var used to be
// executed as the validator, so `PYTHON=true` (or cmd.exe) self-authorized any session id.
for (const fake of ['true', 'cmd.exe']) {
  test(`PYTHON=${fake} cannot replace the validator: still DENIED by check_website_deploy`, { skip: NEEDS_VALIDATOR }, () => {
    const env = {
      ...process.env,
      NETLIFY_GUARD_DRY_RUN: '1',
      CLAUDE_CODE_SESSION_ID: 'netlify-guard-test-no-such-session',
      PYTHON: fake,
    };
    const r = spawnSync(process.execPath, [GUARD, 'deploy', '-p'], { env, encoding: 'utf8' });
    assert.equal(r.status, 5, `expected exit 5; stderr:\n${r.stderr}`);
    // Asserts the real validator's own verdict, not merely "something exited non-zero".
    assert.match(r.stderr, /check_website_deploy: DENY/);
    assert.doesNotMatch(r.stderr, /authorized prod deploy|DRY RUN/);
  });
}

// The validator reads ORA_OVERRIDE_SESSIONS_DIR as a test seam. The guard must not hand it
// the caller's environment, or a forged token in an attacker-chosen directory self-authorizes.
test('a forged token reachable only via ORA_OVERRIDE_SESSIONS_DIR does NOT authorize', { skip: NEEDS_VALIDATOR }, () => {
  const sid = 'netlify-guard-test-forged-session';
  const root = mkdtempSync(path.join(tmpdir(), 'netlify-guard-forged-'));
  try {
    mkdirSync(path.join(root, sid, 'overrides'), { recursive: true });
    writeFileSync(
      path.join(root, sid, 'overrides', 'allow-website-deploy'),
      `scope: website-deploy\nsession: ${sid}\nreason: forged by test\n`,
    );
    const env = {
      ...process.env,
      NETLIFY_GUARD_DRY_RUN: '1',
      CLAUDE_CODE_SESSION_ID: sid,
      ORA_OVERRIDE_SESSIONS_DIR: root,
    };
    const r = spawnSync(process.execPath, [GUARD, 'deploy', '-p'], { env, encoding: 'utf8' });
    assert.equal(r.status, 5, `expected exit 5; stderr:\n${r.stderr}`);
    assert.match(r.stderr, /check_website_deploy: DENY/);
    assert.doesNotMatch(r.stderr, /authorized prod deploy|DRY RUN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const NON_PROD = [
  ['deploy'],
  ['deploy', '--draft'],
  ['deploy', '--alias', 'preview'],
  ['deploy', '-s', 'app-site'],
  ['deploy', '-sapp'],
  ['deploy', '-m', 'ship it'],
  ['deploy', '-O'],
  ['status'],
  ['--version'],
  ['api', 'listSiteDeploys'],
  ['api', 'getSite', '--data', '{"site_id":"x"}'],
  ['api', '--list'],
  ['dev'],
];

for (const args of NON_PROD) {
  test(`guard lets \`netlify ${args.join(' ')}\` through (dry-run exit 0)`, () => {
    const r = runGuard(args);
    assert.equal(r.status, 0, `expected exit 0; stderr:\n${r.stderr}`);
    assert.match(r.stderr, /DRY RUN/);
  });
}
