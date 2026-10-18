/**
 * leak-gate-hashes.mjs — LOCAL-ONLY generator for scripts/leak-gate-hashes.json.
 *
 * Reads the machine-local confidential-deal roster (default
 * ~/.claude/hooks/confidential-terms.json, override with LEAK_GATE_ROSTER) and
 * writes salted HMAC hashes of the ACTIVE deals' terms. The roster is the only
 * place plain terms live; nothing here prints, logs or returns one.
 *
 *   node scripts/leak-gate-hashes.mjs           regenerate (keeps the salt)
 *   node scripts/leak-gate-hashes.mjs --check   exit 1 if the committed file is
 *                                               stale vs the local roster
 *   node scripts/leak-gate-hashes.mjs --new-salt  rotate the salt as well
 *   node scripts/leak-gate-hashes.mjs --keyed     derive the hashing salt from the committed salt AND the
 *                                               LEAK_GATE_KEY env secret (recommended once any deal is active)
 *
 * After writing, it dry-scans dist/ and reports COUNTS of files that would now be blocked.
 *
 * RE-RUN whenever the roster changes (deal added, retired, aliases edited),
 * then commit scripts/leak-gate-hashes.json. Roster retirement (active=false)
 * drops the hashes on the next run.
 *
 * CI has no roster. The verify-stage test (tests/site/leak-gate.test.mjs) calls
 * localRosterStatus(), which reports 'absent' there and skips the freshness
 * check; the scan itself still runs against the committed hashes.
 */

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { activeEntries, buildDenylist, effectiveSalt, indexDenylist, rosterDigest, compact, scanFile, SUBSTRING_MIN } from './lib/leak-gate.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const HASH_FILE = path.join(ROOT, 'scripts', 'leak-gate-hashes.json');
export const rosterPath = () => process.env.LEAK_GATE_ROSTER || path.join(os.homedir(), '.claude', 'hooks', 'confidential-terms.json');

export function readCommitted() {
  try {
    return JSON.parse(readFileSync(HASH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** { state: 'absent'|'fresh'|'stale'|'unreadable'|'needs-key', active } — never terms. */
export function localRosterStatus(committed = readCommitted()) {
  const p = rosterPath();
  if (!existsSync(p)) return { state: 'absent', active: 0 };
  let entries;
  try {
    entries = activeEntries(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return { state: 'unreadable', active: 0 };
  }
  if (!committed || !committed.salt) return { state: 'stale', active: entries.length };
  let eff;
  try {
    eff = effectiveSalt(committed.salt, committed.keyed === true);
  } catch {
    return { state: 'needs-key', active: entries.length };
  }
  const same = committed.roster_digest === rosterDigest(entries, eff);
  return { state: same ? 'fresh' : 'stale', active: entries.length };
}

/** Count-only dry run over dist/: which classes of file WOULD hit, so activating a deal does not surprise-block a PR. */
function dryScan(file) {
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(dist)) return null;
  const idx = indexDenylist(file);
  const tally = {};
  let files = 0;
  const walk = (d) => {
    for (const e of readdirSync(path.join(dist, d), { withFileTypes: true })) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else {
        files++;
        const r = scanFile('dist/' + rel, readFileSync(path.join(dist, rel)), idx);
        for (const h of r.hits) {
          const key = `${r.kind}:${h}`;
          tally[key] = (tally[key] || 0) + 1;
        }
      }
    }
  };
  walk('');
  return { files, tally };
}

async function main() {
  const check = process.argv.includes('--check');
  const p = rosterPath();
  if (!existsSync(p)) {
    console.error('[leak-gate] roster not found at the configured path; this script only runs on the roster machine');
    process.exit(2);
  }
  const entries = activeEntries(JSON.parse(await fs.readFile(p, 'utf8')));
  const committed = readCommitted();

  if (check) {
    const s = localRosterStatus(committed);
    console.log(`[leak-gate] hash file state vs local roster: ${s.state} (${s.active} active terms)`);
    process.exit(s.state === 'fresh' ? 0 : 1);
  }

  const keyed = process.argv.includes('--keyed') || (committed && committed.keyed === true && !process.argv.includes('--unkeyed'));
  const keep = committed && /^[0-9a-f]{64}$/.test(committed.salt || '') && !process.argv.includes('--new-salt');
  const salt = keep ? committed.salt : crypto.randomBytes(32).toString('hex');
  const eff = effectiveSalt(salt, keyed);
  const file = buildDenylist(entries, salt, keyed);
  file.roster_digest = rosterDigest(entries, eff);
  await fs.writeFile(HASH_FILE, JSON.stringify(file, null, 2) + '\n');

  console.log(`[leak-gate] wrote ${file.entries.length} hashes for ${entries.length} active terms (${keep ? 'salt kept' : 'new salt'}, ${keyed ? 'KEYED' : 'unkeyed'})`);
  if (entries.length && !keyed) {
    console.warn(
      '[leak-gate] WARNING: an active deal is in this file and it is UNKEYED, so anyone with the repo can dictionary-attack it. ' +
        'Recommended: set LEAK_GATE_KEY (16+ random chars) here, in the GitHub Actions secrets and in the Netlify environment, then re-run with --keyed.'
    );
  }
  const short = new Set(entries.map((e) => compact(e.term)).filter((c) => c && c.length < SUBSTRING_MIN)).size;
  if (short) {
    console.warn(
      `[leak-gate] WARNING: ${short} term(s) are shorter than ${SUBSTRING_MIN} normalized chars. Short or guessable names can be ` +
        'brute-forced from the committed hashes (see docs/leak-gate.md) and match whole words only. Add a longer, multi-word alias ' +
        '(name plus street/city) to the roster entry; do not rely on this gate alone for a common-word name.'
    );
  }
  try {
    const dry = dryScan(file);
    if (!dry) console.log('[leak-gate] dry scan skipped: run `npm run build` first to see what the new hashes would block');
    else if (!Object.keys(dry.tally).length) console.log(`[leak-gate] dry scan of dist/ (${dry.files} files): nothing would be blocked`);
    else {
      console.warn(`[leak-gate] dry scan of dist/ (${dry.files} files): the new hashes WOULD BLOCK these (counts by file kind and class; run npm run test:leak-gate for paths):`);
      for (const [k, n] of Object.entries(dry.tally).sort()) console.warn(`  ${k}: ${n}`);
    }
  } catch {
    console.warn('[leak-gate] dry scan could not run (message suppressed)');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Deliberately no error text: a JSON parse error can quote roster content.
    console.error('[leak-gate] failed (message suppressed so no roster text can be echoed); check the roster file is valid JSON, and LEAK_GATE_KEY if the file is keyed');
    process.exit(1);
  });
}
