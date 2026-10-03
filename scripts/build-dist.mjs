/**
 * build-dist.mjs — assembles the Netlify publish directory (dist/).
 *
 * The repo root mixes the public site with internal tooling (scripts/, evals/,
 * netlify/ source). Deploys publish only what SITE_FILES/SITE_DIRS name into
 * dist/. Every root entry must be classified: anything not in the publish
 * allowlist or in EXPECTED_EXCLUSIONS fails the build — a new file can neither
 * silently ship nor silently vanish. Dot-prefixed entries are always private.
 *
 * Run via: node scripts/build-dist.mjs   (also the Netlify [build] command)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { cspLines, requiredHashes, scriptSrcTokens } from './csp-hashes.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Directories copied recursively.
const SITE_DIRS = ['assets', 'images', 'fonts', 'markets', 'properties', 'resources'];

// Every published root file, enumerated one-by-one — no wildcards. Adding a
// public page means adding it here; that is deliberate, this is the boundary
// that keeps internal artifacts off oxfordra.net.
const SITE_FILES = [
  // pages
  '404.html',
  'about.html',
  'application-received.html',
  'available-space.html',
  'broker-intake-form.html',
  'broker-ledger-form.html',
  'chat-lead-form.html',
  'contact.html',
  'for-brokers.html',
  'index.html',
  'pipeline-failures-form.html',
  'portfolio.html',
  'privacy.html',
  'sell-your-building.html',
  'tenant-application.html',
  'tenant-resources.html',
  'terms.html',
  'track-record.html',
  // styles
  'application-style.css',
  'available-space.css',
  'portfolio.css',
  'styles.css',
  // scripts
  'application-script.js',
  'broker-upload.js',
  'listings.js',
  'portfolio.js',
  'script.js',
  // platform + assets
  '_headers',
  '_redirects',
  'favicon.ico',
  'favicon.png',
  'apple-touch-icon.png',
  'manifest.json',
  'llms.txt',
  'robots.txt',
  'sitemap.xml',
  'Oxford-Realty-Advisors-Overview.pdf',
  'Oxford-Sale-Ready-Checklist.pdf',
];

// Root entries that exist and must stay unpublished. An entry in neither list
// fails the build until it is classified.
const EXPECTED_EXCLUSIONS = ['application-script.file-size.test.js', 'data', 'deno.lock', 'docs', 'evals', 'netlify', 'netlify.toml', 'node_modules', 'package-lock.json', 'package.json', 'README.md', 'scripts', 'tests'];

// Belt-and-braces: fail rather than ship an incomplete or leaking dist/.
const REQUIRED = ['index.html', '404.html', '_headers', '_redirects', 'styles.css', 'script.js'];
const BANNED = ['scripts', 'evals', 'netlify', 'netlify.toml'];
const MIN_HTML_PAGES = 14;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // An entry on both lists is ambiguous, and the publish branch below wins, so
  // "excluded" would silently ship. Refuse before anything is copied, and clear
  // any stale dist/ so a later `netlify deploy --dir dist` has nothing to send.
  const overlap = [...SITE_FILES, ...SITE_DIRS].filter((name) => EXPECTED_EXCLUSIONS.includes(name));
  if (overlap.length > 0) {
    await fs.rm(DIST, { recursive: true, force: true });
    console.error(`[build-dist] FAIL: listed as both published and excluded: ${overlap.join(', ')} — keep it in exactly one list in scripts/build-dist.mjs`);
    process.exit(1);
  }

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  const copied = [];
  const excluded = [];
  const failures = [];

  for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
    const name = entry.name;
    if (name === 'dist' || name.startsWith('.')) continue;
    const allowed = entry.isDirectory() ? SITE_DIRS.includes(name) : SITE_FILES.includes(name);
    if (allowed) {
      // Unit tests that sit next to their module (e.g. assets/chat.test.js)
      // never ship, and neither do dot-files at any depth (editor/OS droppings,
      // resources/.draft-notes): the root-level dot rule has to hold inside
      // published directories too.
      await fs.cp(path.join(ROOT, name), path.join(DIST, name), {
        recursive: entry.isDirectory(),
        filter: (src) => !/\.test\.[cm]?js$/.test(src) && !path.basename(src).startsWith('.'),
      });
      copied.push(entry.isDirectory() ? name + '/' : name);
    } else if (EXPECTED_EXCLUSIONS.includes(name)) {
      excluded.push(entry.isDirectory() ? name + '/' : name);
    } else {
      failures.push(
        `unclassified root entry: ${name} — add it to SITE_FILES/SITE_DIRS (publish) ` +
          'or EXPECTED_EXCLUSIONS (keep private) in scripts/build-dist.mjs'
      );
    }
  }

  for (const file of SITE_FILES) {
    if (!(await exists(path.join(DIST, file)))) failures.push(`allowlisted file missing from repo: ${file}`);
  }
  for (const req of REQUIRED) {
    if (!(await exists(path.join(DIST, req)))) failures.push(`missing required file: ${req}`);
  }
  const htmlCount = copied.filter((n) => n.endsWith('.html')).length;
  if (htmlCount < MIN_HTML_PAGES) failures.push(`only ${htmlCount} HTML pages (< ${MIN_HTML_PAGES})`);
  for (const dir of SITE_DIRS) {
    const entries = await fs.readdir(path.join(DIST, dir)).catch(() => []);
    if (entries.length === 0) failures.push(`dist/${dir} is empty`);
  }
  for (const banned of new Set([...BANNED, ...EXPECTED_EXCLUSIONS])) {
    if (await exists(path.join(DIST, banned))) failures.push(`internal path leaked into dist: ${banned}`);
  }

  // Fail closed on CSP drift: script-src allows inline scripts by hash, so a page whose inline
  // script changed without regenerating the hashes would ship and be silently blocked in the
  // browser. Checked against the bytes about to be published, not the source tree.
  if (await exists(path.join(DIST, '_headers'))) {
    const headers = await fs.readFile(path.join(DIST, '_headers'), 'utf8');
    const tokens = scriptSrcTokens(headers);
    if (cspLines(headers).length !== 1 || !tokens) {
      failures.push('_headers must contain exactly one Content-Security-Policy line with a script-src directive');
    } else {
      const need = requiredHashes(DIST);
      const have = tokens.filter((t) => t.startsWith("'sha256-"));
      const missing = need.filter((h) => !have.includes(h)).length;
      const stale = have.filter((h) => !need.includes(h)).length;
      if (tokens.includes("'unsafe-inline'") || missing || stale) {
        failures.push(`CSP script-src is out of date (${missing} inline script hash(es) missing, ${stale} stale${tokens.includes("'unsafe-inline'") ? ", 'unsafe-inline' present" : ''}): run node scripts/csp-hashes.mjs --write`);
      }
    }
  }

  console.log(`[build-dist] published: ${copied.sort().join(', ')}`);
  console.log(`[build-dist] excluded (never deployed): ${excluded.sort().join(', ')}`);
  if (failures.length > 0) {
    // A failed build leaves nothing deployable behind.
    await fs.rm(DIST, { recursive: true, force: true });
    console.error(`[build-dist] FAIL:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`[build-dist] OK — ${copied.length} root entries -> dist/ (${htmlCount} pages)`);
}

main().catch(async (err) => {
  // A build that threw must not leave a half-assembled dist/ that could be deployed.
  await fs.rm(DIST, { recursive: true, force: true }).catch(() => {});
  console.error('[build-dist] FAIL:', err);
  process.exit(1);
});
