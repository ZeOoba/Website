#!/usr/bin/env node
// Post-deploy check: does the CSP a deployment actually SERVES allow every inline script
// that deployment actually serves?
//
//   node scripts/verify-live-csp.mjs                                  https://oxfordra.net
//   node scripts/verify-live-csp.mjs https://deploy-preview-N--snazzy-frangipane-de3841.netlify.app
//
// The repo tests prove the hashes in _headers match the SOURCE pages. This proves the
// same thing about the bytes on the wire, which can differ if the platform rewrites HTML
// (for example Netlify's "Asset optimization" / snippet injection, or an edge function).
// A rewritten inline script no longer matches its hash and is silently blocked, so run this
// after every deploy that touches a page or _headers, and against a deploy preview before merging.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOf, inlineScriptTexts } from './csp-hashes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.argv[2] || 'https://oxfordra.net').replace(/\/$/, '');

const sitemap = readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const paths = [...sitemap.matchAll(/<loc>https:\/\/oxfordra\.net([^<]*)<\/loc>/g)].map((m) => m[1] || '/');
paths.push('/tenant-application', '/application-received', '/definitely-not-a-page');

let failures = 0;
let checked = 0;
for (const p of new Set(paths)) {
  const res = await fetch(base + p, { redirect: 'follow' });
  const html = await res.text();
  const csp = res.headers.get('content-security-policy') || '';
  const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => /^script-src(\s|$)/.test(d)) || '';
  const allowed = new Set(scriptSrc.split(/\s+/).filter((t) => t.startsWith("'sha256-")));
  const problems = [];
  if (!scriptSrc) problems.push('no script-src in the served CSP');
  if (scriptSrc.includes("'unsafe-inline'")) problems.push("script-src still allows 'unsafe-inline'");
  for (const text of inlineScriptTexts(html)) {
    const hash = hashOf(text);
    if (!allowed.has(hash)) problems.push(`inline script not in the CSP: ${hash.slice(0, 20)}... starts "${text.trim().slice(0, 50).replace(/\s+/g, ' ')}"`);
  }
  checked++;
  if (problems.length) { failures++; console.log(`FAIL ${p} (HTTP ${res.status})\n  - ${problems.join('\n  - ')}`); }
}
console.log(`${checked} pages checked on ${base}: ${failures ? `${failures} FAILED` : 'every inline script is allowed by the served CSP'}`);
process.exit(failures ? 1 : 0);
