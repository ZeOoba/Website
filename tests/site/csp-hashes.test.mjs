// script-src carries one sha256 per inline script instead of 'unsafe-inline'.
//
// Why this is a test and not just a build step: an inline script whose hash is missing
// from _headers is blocked by the browser on the live site, silently. Nothing errors in
// CI unless something compares the two. These tests are that comparison, plus the rule
// that nothing may need the loophole back (inline event-handler attributes and
// javascript: URLs cannot be hashed and would be blocked too).
//
// Source-level and fast. The rendered check (every built page, real browser, zero
// violations) is csp-all-pages.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cspLines, hashOf, htmlPages, inlineScriptTexts, inlineScripts, requiredHashes, scriptSrcTokens } from '../../scripts/csp-hashes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const headers = readFileSync(path.join(ROOT, '_headers'), 'utf8');
const tokens = scriptSrcTokens(headers) ?? [];

test('CSP-1 script-src has no \'unsafe-inline\' and no \'unsafe-eval\'', () => {
  assert.equal(cspLines(headers).length, 1, '_headers must carry exactly one Content-Security-Policy line, or "the" script-src is ambiguous');
  assert.ok(tokens.length > 0, 'no script-src directive in _headers');
  assert.ok(!tokens.includes("'unsafe-inline'"), "script-src still allows 'unsafe-inline': any injected <script> would run");
  assert.ok(!tokens.includes("'unsafe-eval'"), "script-src allows 'unsafe-eval'");
  assert.ok(tokens.includes("'self'"), "script-src lost 'self'");
});

test('CSP-2 script-src lists exactly the sha256 of every inline script the pages ship (run: node scripts/csp-hashes.mjs --write)', () => {
  const have = tokens.filter((t) => t.startsWith("'sha256-")).sort();
  const need = requiredHashes(ROOT);
  const missing = need.filter((h) => !have.includes(h));
  const stale = have.filter((h) => !need.includes(h));
  assert.deepEqual(missing, [], `${missing.length} inline script(s) have no hash in _headers and would be BLOCKED on the live site. Run: node scripts/csp-hashes.mjs --write`);
  assert.deepEqual(stale, [], `${stale.length} hash(es) in _headers match no inline script (an edited or removed script). Run: node scripts/csp-hashes.mjs --write`);
});

test('CSP-3 the hashes cover text/partytown blocks too (Partytown re-inserts them as inline scripts when its service worker cannot start)', () => {
  const partytown = inlineScripts(ROOT).filter((s) => /gtag\('config'/.test(s.text));
  assert.ok(partytown.length >= 20, `expected the gtag block on every page, found ${partytown.length}`);
  for (const s of partytown) assert.ok(tokens.includes(s.hash), `${s.file}: the gtag/Partytown block has no hash, so the fallback path would be blocked`);
});

test('CSP-4 no page relies on what a hash cannot allow: inline event-handler attributes and javascript: URLs', () => {
  const offenders = [];
  for (const file of htmlPages(ROOT)) {
    const html = readFileSync(path.join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    for (const m of html.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)) offenders.push(`${file}: inline ${m[1]}= handler`);
    if (/(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(html)) offenders.push(`${file}: javascript: URL`);
  }
  assert.deepEqual(offenders, [], 'these would be blocked by a strict script-src and cannot be fixed with a hash; move them into addEventListener code');
});

test('CSP-6 the script finder is not fooled by look-alike attributes, quoted ">" or CRLF', () => {
  const texts = inlineScriptTexts([
    '<script data-src="x.js">A</script>',              // data-src is not src: this IS inline
    '<script data-type="json">B</script>',              // data-type is not type: this IS executable
    '<script title="a > b">C</script>',                 // ">" inside a quoted attribute
    '<script src="/x.js"></script>',                    // external: no hash
    '<script type="application/ld+json">{"a":1}</script>', // data: no hash
    '<script type="text/partytown">D</script>',         // Partytown fallback: hashed
    '<SCRIPT>E\r\nF</SCRIPT>',                          // case-insensitive, CRLF normalised
  ].join('\n'));
  assert.deepEqual(texts, ['A', 'B', 'C', 'D', 'E\nF']);
  assert.match(hashOf('E\nF'), /^'sha256-[A-Za-z0-9+/]{43}='$/);
});

test('CSP-7 unpkg.com is allowed only for the exact files the pages load, never as a whole host', () => {
  const csp = headers.match(/Content-Security-Policy:\s*([^\r\n]*)/)?.[1] ?? '';
  const directive = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '').split(/\s+/).slice(1);
  const scriptSrc = directive('script-src');
  const styleSrc = directive('style-src');
  for (const [name, list] of [['script-src', scriptSrc], ['style-src', styleSrc]]) {
    for (const t of list.filter((x) => x.includes('unpkg.com'))) {
      assert.match(t, /^https:\/\/unpkg\.com\/[^/\s]+\/.*[^/]$/, `${name} allows "${t}": a bare host or directory lets anyone's package on unpkg run on this site; allow the exact file`);
    }
  }
  const used = { script: new Set(), style: new Set() };
  for (const file of htmlPages(ROOT)) {
    const html = readFileSync(path.join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of html.matchAll(/<script\b[^>]*\ssrc=["'](https:\/\/unpkg\.com\/[^"']+)["']/gi)) used.script.add(m[1]);
    for (const m of html.matchAll(/<link\b[^>]*\shref=["'](https:\/\/unpkg\.com\/[^"']+)["'][^>]*>/gi)) if (/rel=["']stylesheet["']|as=["']style["']/i.test(m[0])) used.style.add(m[1]);
  }
  assert.ok(used.script.size + used.style.size > 0, 'no unpkg usage found: if Leaflet moved off unpkg, drop its CSP tokens and this test');
  for (const u of used.script) assert.ok(scriptSrc.includes(u), `a page loads ${u} but script-src does not allow that exact file, so it is blocked on the live site`);
  for (const u of used.style) assert.ok(styleSrc.includes(u), `a page loads ${u} but style-src does not allow that exact file, so it is blocked on the live site`);
});

test('CSP-5 the injection-hardening directives are still there (a hash list is only worth having next to them)', () => {
  const csp = headers.match(/Content-Security-Policy:\s*([^\r\n]*)/)?.[1] ?? '';
  for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), `CSP lost "${d}"`);
});
