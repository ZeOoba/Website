/**
 * verify-jsonld.mjs — repo-wide gate around scripts/validate-jsonld.js.
 *
 * validate-jsonld.js checks ONE file and answers one question: does every
 * JSON-LD block in it parse? Until now it was run by hand, on whichever page
 * someone remembered to check. This walks the built dist/ and runs it on every
 * page that has structured data, so the check happens whether or not anyone
 * remembers.
 *
 * It also adds the assertion the per-file validator structurally cannot make:
 * that the key pages still HAVE structured data. validate-jsonld.js can only
 * see malformed JSON-LD; deleting the block entirely is invisible to it (the
 * file is simply never passed in). REQUIRED_JSONLD_PAGES is that floor.
 *
 * Run: node scripts/verify-jsonld.mjs   (after `npm run build`)
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-jsonld.js');

// Pages whose structured data is load-bearing for search/AI surfaces. Losing a
// block from any of these is a regression even though the JSON that remains
// still parses.
const REQUIRED_JSONLD_PAGES = [
  'index.html',
  'about.html',
  'contact.html',
  'portfolio.html',
  'for-brokers.html',
  'available-space.html',
];

// Same tag definition validate-jsonld.js parses with (attribute-order
// independent), so a page is never counted here but skipped there.
const { JSONLD_OPEN_SOURCE } = createRequire(import.meta.url)('./validate-jsonld.js');
const JSONLD_MARKER = new RegExp(JSONLD_OPEN_SOURCE, 'i');

async function walkHtml(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkHtml(full)));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

async function main() {
  try {
    await fs.access(DIST);
  } catch {
    console.error('[verify-jsonld] FAIL: dist/ not found — run `npm run build` first.');
    process.exit(1);
  }

  const htmlFiles = (await walkHtml(DIST)).sort();
  const withJsonLd = [];
  for (const file of htmlFiles) {
    const html = await fs.readFile(file, 'utf8');
    if (JSONLD_MARKER.test(html)) withJsonLd.push(file);
  }

  const failures = [];

  const relWithJsonLd = new Set(withJsonLd.map((f) => path.relative(DIST, f).split(path.sep).join('/')));
  for (const required of REQUIRED_JSONLD_PAGES) {
    if (!relWithJsonLd.has(required)) {
      failures.push(`required page lost its JSON-LD block entirely: ${required}`);
    }
  }

  for (const file of withJsonLd) {
    const rel = path.relative(DIST, file).split(path.sep).join('/');
    const result = spawnSync(process.execPath, [VALIDATOR, file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`invalid JSON-LD in ${rel}: ${(result.stderr || result.stdout || '').trim()}`);
    }
  }

  if (failures.length > 0) {
    console.error(`[verify-jsonld] FAIL:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(
    `[verify-jsonld] OK — ${withJsonLd.length} page(s) with structured data validated ` +
      `(${htmlFiles.length} HTML pages scanned, ${REQUIRED_JSONLD_PAGES.length} required pages present)`
  );
}

main().catch((err) => {
  console.error('[verify-jsonld] FAIL:', err);
  process.exit(1);
});
