#!/usr/bin/env node
// Live check: are the Netlify form notifications wired the way this repo assumes? Read-only.
//
//   node scripts/check-form-hooks.mjs                      reads the live hooks with the local netlify CLI login
//   node scripts/check-form-hooks.mjs --hooks-json f.json  checks a saved `netlify api listHooksBySiteId` response
//
// Fails (exit 1) when a webhook notify function in netlify/functions/ has no submission_created hook covering its
// form (it then never runs: owner-lead-notify.js, found 2026-11-05), or when a registered form notifies no one.
// Exit 2 when the hooks cannot be read. Prints no secrets: hook signature secrets are never read into the report,
// and notification emails are masked. Not part of `npm run verify` (CI has no Netlify login); run it after any
// change to a notify function or to Netlify's form notifications, and from the weekly site check.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webhookTargets, auditFormHooks, formatReport } from './lib/form-hooks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ID = process.env.NETLIFY_SITE_ID || '95ac0a0f-a84d-4400-b919-b8d7a8526646'; // oxfordra.net (snazzy-frangipane-de3841)
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

function functionSources() {
  const dir = path.join(ROOT, 'netlify', 'functions');
  const out = {};
  for (const f of readdirSync(dir)) if (/\.(m?js)$/.test(f)) out[`netlify/functions/${f}`] = readFileSync(path.join(dir, f), 'utf8');
  return out;
}

// Every form the deployed site registers with Netlify Forms: a <form> with data-netlify="true" (or `netlify`).
const SKIP = new Set(['dist', 'node_modules', '.netlify', '.git', 'tests', 'evals', 'scripts', 'netlify', 'docs', '.claude', 'data']);
function registeredForms(rel = '') {
  const names = [];
  for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) names.push(...registeredForms(r)); continue; }
    if (!e.name.endsWith('.html')) continue;
    const html = readFileSync(path.join(ROOT, r), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
      if (!/\bdata-netlify\s*=\s*["']true["']|\snetlify(\s|>|=)/i.test(m[1])) continue;
      const named = /\bname\s*=\s*["']([^"']+)["']/i.exec(m[1]);
      const hidden = /<input\b[^>]*name\s*=\s*["']form-name["'][^>]*value\s*=\s*["']([^"']+)["']/i.exec(m[2]);
      const name = (named && named[1]) || (hidden && hidden[1]);
      if (name) names.push(name);
    }
  }
  return names;
}

function liveHooks() {
  const saved = flag('--hooks-json');
  if (saved) return JSON.parse(readFileSync(saved, 'utf8'));
  const cli = path.join(ROOT, 'node_modules', 'netlify-cli', 'bin', 'run.js');
  const stdout = execFileSync(process.execPath, [cli, 'api', 'listHooksBySiteId', '--data', JSON.stringify({ site_id: SITE_ID })], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

let hooks;
try {
  hooks = liveHooks();
  if (!Array.isArray(hooks)) throw new Error('response is not a list of hooks');
} catch (err) {
  console.error(`could not read the site's Netlify hooks (${String(err && err.message ? err.message : err).split('\n')[0]}); log in with the netlify CLI or pass --hooks-json`);
  process.exit(2);
}
const report = auditFormHooks({ hooks, targets: webhookTargets(functionSources()), forms: registeredForms() });
console.log(formatReport(report));
process.exit(report.problems.length ? 1 : 0);
