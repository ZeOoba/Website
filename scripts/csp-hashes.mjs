#!/usr/bin/env node
// CSP script-src hashes for every inline <script> the site ships.
//
// `_headers` used to allow 'unsafe-inline' for scripts, which switches off CSP's main
// XSS defence: any injected <script> would run. It now lists one sha256 per distinct
// inline script instead, so an injected script has no matching hash and is blocked.
//
//   node scripts/csp-hashes.mjs            print the hashes the pages need
//   node scripts/csp-hashes.mjs --check    exit 1 if _headers is out of date
//   node scripts/csp-hashes.mjs --write    rewrite the script-src hashes in _headers
//
// Editing ANY inline <script> changes its hash. Until _headers is regenerated the
// browser blocks that script on the live site, silently, so the build (build-dist.mjs),
// tests/site/csp-hashes.test.mjs and scripts/verify-live-csp.mjs all compare the two.
// After editing an inline script, run --write.
//
// Scope decisions:
//  - <script type="text/partytown"> is included. The browser never runs it, but if the
//    service worker cannot start Partytown re-inserts the same text as a normal inline
//    script (its documented fallback), and that needs a matching hash.
//  - application/ld+json and other JSON data blocks are not executable, so no hash.
//  - Text is hashed after normalising CRLF to LF, which is what an HTML parser hands
//    the CSP check, so the hash is the same on a Windows checkout and on Netlify.
//  - style-src keeps 'unsafe-inline': 350+ style="" attributes ship in the markup and
//    hashing attributes needs 'unsafe-hashes'. CSS injection is a far smaller risk.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_DIRS = new Set(['dist', 'node_modules', '.netlify', '.git', 'tests', 'evals', 'scripts', 'netlify', 'docs', '.claude', 'data']);

export function htmlPages(root = ROOT, rel = '') {
  const files = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!PRIVATE_DIRS.has(e.name)) files.push(...htmlPages(root, r)); }
    else if (e.name.endsWith('.html')) files.push(r);
  }
  return files.sort();
}

export const hashOf = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

// Text of every inline <script> a browser may execute, line endings normalised. The tag
// pattern tolerates '>' inside a quoted attribute value; src/type are matched as whole
// attribute names so data-src= and data-type= are not mistaken for them.
export function inlineScriptTexts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi)) {
    if (/(?:^|\s)src\s*=/i.test(m[1])) continue;
    const type = (m[1].match(/(?:^|\s)type\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
    if (/json/i.test(type)) continue;
    out.push(m[2].replace(/\r\n?/g, '\n'));
  }
  return out;
}

// Every inline script across the source pages, as { file, hash, text }.
export function inlineScripts(root = ROOT) {
  const out = [];
  for (const file of htmlPages(root)) {
    for (const text of inlineScriptTexts(readFileSync(path.join(root, file), 'utf8'))) out.push({ file, text, hash: hashOf(text) });
  }
  return out;
}

export const requiredHashes = (root = ROOT) => [...new Set(inlineScripts(root).map((s) => s.hash))].sort();

// The site's single CSP line in _headers. More than one would make "the" script-src ambiguous.
export const cspLines = (headersText) => [...headersText.matchAll(/^[ \t]*Content-Security-Policy:[^\r\n]*/gm)].map((m) => m[0]);

export function scriptSrcTokens(headersText) {
  const line = cspLines(headersText)[0] ?? '';
  const directive = line.replace(/^[ \t]*Content-Security-Policy:\s*/, '').split(';').map((d) => d.trim()).find((d) => /^script-src(\s|$)/.test(d));
  return directive ? directive.split(/\s+/).slice(1) : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const need = requiredHashes();
  const headersPath = path.join(ROOT, '_headers');
  const headers = readFileSync(headersPath, 'utf8');
  const lines = cspLines(headers);
  const tokens = scriptSrcTokens(headers);
  if (lines.length !== 1) { console.error(`_headers must contain exactly one Content-Security-Policy line (found ${lines.length})`); process.exit(2); }
  if (!tokens) { console.error('the Content-Security-Policy in _headers has no script-src directive'); process.exit(2); }
  const have = tokens.filter((t) => t.startsWith("'sha256-")).sort();
  const same = have.length === need.length && have.every((h, i) => h === need[i]);

  if (mode === '--write') {
    // Keep every non-hash, non-'unsafe-inline' token in its original position; hashes go right after 'self'.
    const kept = tokens.filter((t) => !t.startsWith("'sha256-") && t !== "'unsafe-inline'");
    const at = Math.max(kept.indexOf("'self'") + 1, 0);
    const next = [...kept.slice(0, at), ...need, ...kept.slice(at)];
    const newLine = lines[0].replace(/(^|[\s:;])script-src(?=\s)[^;]*/, (_m, pre) => `${pre}script-src ${next.join(' ')}`);
    if (newLine === lines[0] && !same) { console.error('could not rewrite script-src: the directive has no sources to anchor on'); process.exit(2); }
    const updated = headers.replace(lines[0], () => newLine);
    if (updated !== headers) writeFileSync(headersPath, updated);
    console.log(`_headers script-src: ${need.length} hashes${updated === headers ? ' (already current)' : ' written'}`);
  } else if (mode === '--check') {
    if (!same || tokens.includes("'unsafe-inline'")) {
      const missing = need.filter((h) => !have.includes(h));
      const extra = have.filter((h) => !need.includes(h));
      console.error(`_headers script-src is out of date (${missing.length} missing, ${extra.length} stale${tokens.includes("'unsafe-inline'") ? ", still has 'unsafe-inline'" : ''}). Run: node scripts/csp-hashes.mjs --write`);
      process.exit(1);
    }
    console.log(`_headers script-src is current (${need.length} hashes)`);
  } else {
    for (const h of need) console.log(h);
  }
}
