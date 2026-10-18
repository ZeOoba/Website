/**
 * stamp-asset-versions.mjs — content-hash cache-busters for dist/*.html.
 * Used by build-dist.mjs; kept separate so tests can import it without running the build.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Vendored third-party bundle: its ?v= is the upstream release (tests pin it) and the files
// it lazy-loads are requested without any query, so hashing the entry point would not help.
const VENDORED_ASSET_PREFIX = '/assets/partytown/';

async function listHtml(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listHtml(p)));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Rewrites every same-site .css/.js reference in dist/*.html to ?v=<first 10 hex of the file's
// sha256> and returns build failures. A reference pointing at a file that
// is not in dist, or carrying a query other than ?v=, fails the build (a bare reference just gets stamped): under `max-age=31536000, immutable` either one is a stale-code
// trap. Source ?v= values stay (tests and tooling read them) but no longer decide what ships.
export async function stampAssetVersions(dist) {
  const failures = [];
  const hashes = new Map();
  const hashOf = async (urlPath) => {
    if (!hashes.has(urlPath)) {
      const file = path.join(dist, ...urlPath.split('/').filter(Boolean));
      const bytes = await fs.readFile(file).catch(() => null);
      hashes.set(urlPath, bytes && createHash('sha256').update(bytes).digest('hex').slice(0, 10));
    }
    return hashes.get(urlPath);
  };
  // A reference is an href/src attribute value; the value may sit in single or double quotes.
  const REF = /\b(href|src)=(["'])(\/[^"'?#\s]+\.(?:css|js))(\?[^"'#]*)?(#[^"']*)?\2/g;
  for (const file of await listHtml(dist)) {
    const rel = path.relative(dist, file).split(path.sep).join('/');
    const html = await fs.readFile(file, 'utf8');
    const refs = [...html.matchAll(REF)];
    let out = '';
    let last = 0;
    for (const m of refs) {
      const [whole, attr, quote, urlPath, query = '', frag = ''] = m;
      out += html.slice(last, m.index);
      last = m.index + whole.length;
      if (urlPath.startsWith(VENDORED_ASSET_PREFIX)) {
        out += whole;
        continue;
      }
      const h = await hashOf(urlPath);
      if (!h) {
        failures.push(`${rel}: references ${urlPath}, which is not in dist/`);
        out += whole;
      } else if (!/^\?v=/.test(query) && query !== '') {
        failures.push(`${rel}: ${urlPath}${query} has a query other than ?v= — the asset hash cannot be stamped`);
        out += whole;
      } else {
        out += `${attr}=${quote}${urlPath}?v=${h}${frag}${quote}`;
      }
    }
    out += html.slice(last);
    if (out !== html) await fs.writeFile(file, out);
  }
  return failures;
}
