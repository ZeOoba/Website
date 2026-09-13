/**
 * serve-dist.mjs — a local static server for dist/ that APPLIES `_headers`.
 *
 * WHY THIS EXISTS (this is the load-bearing part of the CSP check, read before
 * "simplifying" it into `npx http-server dist/`):
 *
 * The site's Content-Security-Policy lives in `_headers`, which is a *Netlify*
 * construct — it is not HTML, it is not in any page, and no ordinary static
 * server knows about it. Serve dist/ with a plain static server and every
 * response goes out with NO CSP header at all. A browser test that then asserts
 * "zero CSP violations" passes trivially, forever, no matter what the allowlist
 * says: a green check that verifies nothing. That fake gate would have caught
 * none of the reactive `_headers` patches in this repo's history.
 *
 * So this server parses `_headers` itself and applies the matching rules to
 * every response. The CSP smoke test is only meaningful because of this file.
 *
 * Also usable standalone, replacing the ad-hoc static server the repo's manual
 * browser check has used until now — with the advantage that what you see in
 * the browser is now header-faithful to production:
 *
 *   node scripts/serve-dist.mjs --port 8788 [--root dist]
 *
 * NOT emulated, deliberately: `_redirects`. Reimplementing Netlify's redirect
 * engine would be a second, separately-wrong copy of its semantics; tests
 * request real file paths instead. Pretty-URL resolution (/about -> about.html)
 * IS emulated because it is Netlify's default static behavior, not a rule.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * Parse Netlify `_headers` syntax into ordered rules.
 *
 * Grammar: a line beginning with `/` opens a rule; every following indented
 * `Name: value` line attaches to it. `#` comments and blank lines are skipped.
 *
 * @param {string} text raw `_headers` contents
 * @returns {Array<{pattern: string, regex: RegExp, headers: Array<[string,string]>}>}
 */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line) && line.startsWith('/')) {
      current = { pattern: line.trim(), regex: patternToRegex(line.trim()), headers: [] };
      rules.push(current);
      continue;
    }
    const m = line.match(/^\s+([A-Za-z0-9-]+):\s*(.*)$/);
    if (m && current) current.headers.push([m[1].toLowerCase(), m[2]]);
  }
  return rules;
}

/** Netlify path pattern -> anchored RegExp. `*` is a wildcard, `:param` a segment. */
function patternToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      out += '.*';
    } else if (c === ':') {
      // consume the placeholder name
      let j = i + 1;
      while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j])) j++;
      out += '[^/]+';
      i = j - 1;
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + '$');
}

/** All headers from every rule matching `pathname`, later rules winning per name. */
export function headersForPath(rules, pathname) {
  const merged = new Map();
  for (const rule of rules) {
    if (!rule.regex.test(pathname)) continue;
    for (const [name, value] of rule.headers) merged.set(name, value);
  }
  return merged;
}

async function readFileOrNull(p) {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return null;
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

/**
 * Resolve a request path to a file on disk, emulating Netlify's default static
 * resolution: exact file, then `<path>.html`, then `<path>/index.html`.
 */
async function resolveFile(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const rel = decoded.replace(/^\/+/, '');
  const base = path.resolve(root, rel);
  // Path-traversal guard: never serve outside root.
  if (base !== root && !base.startsWith(root + path.sep)) return null;

  const candidates = decoded.endsWith('/')
    ? [path.join(base, 'index.html')]
    : [base, base + '.html', path.join(base, 'index.html')];
  for (const candidate of candidates) {
    if (candidate !== root && !candidate.startsWith(root + path.sep)) continue;
    const body = await readFileOrNull(candidate);
    if (body) return { file: candidate, body };
  }
  return null;
}

/**
 * Start the server.
 * @param {{root?: string, port?: number}} opts `port: 0` picks an ephemeral port.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export async function startServer({ root = path.join(ROOT, 'dist'), port = 0 } = {}) {
  const absRoot = path.resolve(root);
  const headersPath = path.join(absRoot, '_headers');
  const raw = await readFileOrNull(headersPath);
  if (!raw) {
    // Fail loudly. A silent fallback to "no headers" is the exact failure mode
    // this whole file exists to prevent — it would make the CSP test vacuous.
    throw new Error(
      `[serve-dist] ${headersPath} not found. Run \`npm run build\` first; ` +
        'serving without _headers would make CSP assertions meaningless.'
    );
  }
  const rules = parseHeadersFile(raw.toString('utf8'));

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const hit = await resolveFile(absRoot, pathname);
    const target = hit || (await resolveFile(absRoot, '/404.html'));
    const status = hit ? 200 : 404;
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const headers = { 'content-type': MIME[path.extname(target.file).toLowerCase()] || 'application/octet-stream' };
    for (const [name, value] of headersForPath(rules, pathname)) headers[name] = value;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : target.body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Parse CLI flags. Accepts both `--port 8788` and `--port=8788` (likewise
 * `--root`); unknown flags throw. An invalid port throws rather than reaching
 * `server.listen` as NaN.
 * @param {string[]} args argv without the node/script entries
 * @returns {{port: number, root?: string}}
 */
export function parseCliArgs(args) {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, root: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const raw = values.port ?? '8788';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    throw new Error(`[serve-dist] invalid --port ${JSON.stringify(raw)}; expected an integer 0-65535.`);
  }
  const opts = { port };
  if (values.root) opts.root = values.root;
  return opts;
}

// Standalone CLI mode.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
  startServer(opts).then(
    ({ url: u }) => console.log(`[serve-dist] serving with _headers applied at ${u}`),
    (err) => {
      console.error(String(err.message || err));
      process.exit(1);
    }
  );
}
