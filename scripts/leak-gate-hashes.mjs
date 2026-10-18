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
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { activeEntries, buildDenylist, rosterDigest, compact, SUBSTRING_MIN } from './lib/leak-gate.mjs';

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

/** { state: 'absent'|'fresh'|'stale'|'unreadable', active } — never terms. */
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
  const same = committed.roster_digest === rosterDigest(entries, committed.salt);
  return { state: same ? 'fresh' : 'stale', active: entries.length };
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
    console.log(`[leak-gate] hash file is ${s.state} vs local roster (${s.active} active terms)`);
    process.exit(s.state === 'fresh' ? 0 : 1);
  }

  const keep = committed && /^[0-9a-f]{32,}$/.test(committed.salt || '') && !process.argv.includes('--new-salt');
  const salt = keep ? committed.salt : crypto.randomBytes(32).toString('hex');
  const file = buildDenylist(entries, salt);
  file.roster_digest = rosterDigest(entries, salt);
  await fs.writeFile(HASH_FILE, JSON.stringify(file, null, 2) + '\n');

  const short = new Set(entries.map((e) => compact(e.term)).filter((c) => c && c.length < SUBSTRING_MIN)).size;
  console.log(`[leak-gate] wrote ${file.entries.length} hashes for ${entries.length} active terms (${keep ? 'salt kept' : 'new salt'})`);
  if (short) {
    console.warn(
      `[leak-gate] WARNING: ${short} term(s) are shorter than ${SUBSTRING_MIN} normalized chars. Short or guessable names can be ` +
        'brute-forced from the committed hashes (see docs/leak-gate.md). Add a longer, multi-word alias (name + street/city) ' +
        'to the roster entry before relying on this gate for them; do not commit if the term itself is a common word.'
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Deliberately no error text: a JSON parse error can quote roster content.
    console.error('[leak-gate] failed (message suppressed so no roster text can be echoed); check the roster file is valid JSON');
    process.exit(1);
  });
}
