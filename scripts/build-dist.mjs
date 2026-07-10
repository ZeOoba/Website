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

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Directories copied recursively.
const SITE_DIRS = ['assets', 'images', 'fonts'];

// Every published root file, enumerated one-by-one — no wildcards. Adding a
// public page means adding it here; that is deliberate, this is the boundary
// that keeps internal artifacts off oxfordra.net.
const SITE_FILES = [
  // pages
  '404.html',
  'about.html',
  'application-received.html',
  'available-space.html',
  'chat-lead-form.html',
  'contact.html',
  'for-brokers.html',
  'index.html',
  'portfolio.html',
  'privacy.html',
  'tenant-application.html',
  'tenant-resources.html',
  'terms.html',
  'track-record.html',
  // styles
  'application-style.css',
  'available-space.css',
  'styles.css',
  // scripts
  'application-script.js',
  'listings.js',
  'script.js',
  // platform + assets
  '_headers',
  '_redirects',
  'favicon.ico',
  'favicon.png',
  'apple-touch-icon.png',
  'manifest.json',
  'robots.txt',
  'sitemap.xml',
  'Oxford-Realty-Advisors-Overview.pdf',
];

// Root entries that exist and must stay unpublished. An entry in neither list
// fails the build until it is classified.
const EXPECTED_EXCLUSIONS = ['docs', 'evals', 'netlify', 'netlify.toml', 'node_modules', 'package-lock.json', 'package.json', 'scripts'];

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
      await fs.cp(path.join(ROOT, name), path.join(DIST, name), { recursive: entry.isDirectory() });
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
  for (const banned of BANNED) {
    if (await exists(path.join(DIST, banned))) failures.push(`internal path leaked into dist: ${banned}`);
  }

  console.log(`[build-dist] published: ${copied.sort().join(', ')}`);
  console.log(`[build-dist] excluded (never deployed): ${excluded.sort().join(', ')}`);
  if (failures.length > 0) {
    console.error(`[build-dist] FAIL:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`[build-dist] OK — ${copied.length} root entries -> dist/ (${htmlCount} pages)`);
}

main().catch((err) => {
  console.error('[build-dist] FAIL:', err);
  process.exit(1);
});
