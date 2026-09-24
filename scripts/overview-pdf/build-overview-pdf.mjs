#!/usr/bin/env node
// Renders scripts/overview-pdf/overview.html to /Oxford-Realty-Advisors-Overview.pdf
// with headless Chromium (Edge or Chrome). Chromium's PDF backend embeds the site's
// own web fonts and writes a real, extractable text layer, so never produce this
// file with "Microsoft Print to PDF".
//
//   node scripts/overview-pdf/build-overview-pdf.mjs [--out <path>]
//   CHROME_PATH=<browser exe> overrides browser discovery.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(HERE, 'overview.html');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, 'Oxford-Realty-Advisors-Overview.pdf');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('No Chromium browser found. Set CHROME_PATH to an Edge or Chrome executable.');
  process.exit(1);
}

// A throwaway profile keeps the render isolated from any running browser session.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ora-overview-'));
const tmpOut = path.join(profile, 'overview.pdf');
const res = spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--no-pdf-header-footer',
    '--generate-pdf-document-outline',
    '--virtual-time-budget=5000', // let the woff2 fonts finish loading before print
    `--user-data-dir=${profile}`,
    `--print-to-pdf=${tmpOut}`,
    pathToFileURL(SRC).href,
  ],
  { stdio: 'inherit', timeout: 120_000 },
);
// On Windows the msedge.exe launcher can exit before its child finishes writing the
// PDF, so wait for the file to appear and its size to settle.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let lastSize = -1;
for (let i = 0; i < 120; i++) {
  const size = fs.existsSync(tmpOut) ? fs.statSync(tmpOut).size : -1;
  if (size > 0 && size === lastSize) break;
  lastSize = size;
  sleep(500);
}
if (res.status !== 0 || lastSize <= 0) {
  console.error(`Render failed (exit ${res.status}, output ${lastSize <= 0 ? 'missing' : 'present'}).`);
  process.exit(1);
}
fs.copyFileSync(tmpOut, OUT);
try {
  // Best effort: the browser child can still hold the profile for a moment after the PDF lands.
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch {
  console.warn(`Could not remove temp profile ${profile}; the OS temp cleaner will.`);
}
console.log(`Wrote ${path.relative(ROOT, OUT) || OUT} (${fs.statSync(OUT).size.toLocaleString()} bytes)`);
