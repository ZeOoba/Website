#!/usr/bin/env node
// Serves dist/ with the real headers and runs Lighthouse on four representative pages,
// writing lhr/<page>.json for scripts/lighthouse-summary.mjs.
//
//   node scripts/lighthouse-run.mjs
//
// Why this is a script and not workflow shell: the lighthouse job runs on whichever runner
// CI_RUNNER selects, and a Windows self-hosted runner has no bash on PATH. Inline loops
// and `&` in the workflow therefore failed there ("bash: command not found"). Node behaves
// the same on every runner, and keeping the server and the Lighthouse runs in one process
// means the server cannot be reaped between workflow steps.
//
// Needs dist/ (npm run build) and Playwright's Chromium (npx playwright install chromium).
// Lighthouse is pinned and fetched on demand, so it is not a dependency of the site.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8788;
const PAGES = ['', 'for-brokers', 'available-space', 'sell-your-building'];
const LIGHTHOUSE = 'lighthouse@12.6.1';
const win = process.platform === 'win32';

const chromePath = process.env.CHROME_PATH || createRequire(import.meta.url)('playwright').chromium.executablePath();
mkdirSync(path.join(ROOT, 'lhr'), { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-dist.mjs'), `--port=${PORT}`, '--root=dist'], { cwd: ROOT, stdio: 'inherit' });
let failed = 0;

try {
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) throw new Error('serve-dist did not start within 30 s');

  for (const page of PAGES) {
    const out = path.join('lhr', `${page || 'home'}.json`);
    // npx is npx.cmd on Windows, which only spawns through a shell; there the
    // space-containing flag value needs explicit quotes.
    const flags = win ? '"--headless=new --no-sandbox"' : '--headless=new --no-sandbox';
    const r = spawnSync('npx', ['--yes', LIGHTHOUSE, `http://127.0.0.1:${PORT}/${page}`, '--quiet',
      '--only-categories=performance,accessibility,best-practices,seo', '--output=json', `--output-path=${out}`,
      `--chrome-flags=${flags}`], { cwd: ROOT, stdio: 'inherit', shell: win, env: { ...process.env, CHROME_PATH: chromePath } });
    if (r.status !== 0) { failed++; console.error(`lighthouse failed for /${page} (exit ${r.status})`); }
  }
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
