# Confidential-deal leak gate (Hard Invariant 3)

Active confidential deals must never appear on any external surface until closing. This repo is
git-tracked off-machine and `main` auto-deploys to oxfordra.net, so **no roster term may ever be
committed, logged, or pasted into a test, fixture, comment, PR or prompt**. The gate therefore
works on salted hashes only.

## Pieces

| File | Role |
| --- | --- |
| `~/.claude/hooks/confidential-terms.json` | Roster of record. Machine-local, never in this repo. |
| `scripts/leak-gate-hashes.mjs` | **Local-only** generator. Reads the roster, writes the hash file for **active** deals only. |
| `scripts/leak-gate-hashes.json` | Committed. Per-repo random salt + HMAC-SHA256 (truncated to 128 bits) of each normalized term, with its length and kind. No term text. |
| `scripts/lib/leak-gate.mjs`, `leak-gate-pdf.mjs` | Normalizer, scanner, dependency-free PDF text extractor. Contain no roster data. |
| `tests/site/leak-gate.test.mjs` | The gate (`npm run test:leak-gate`). Run by `npm run verify` right after the build **and** by the Netlify build command in `netlify.toml`, so deploy previews and production cannot ship a hit. |
| `tests/mutation/cases.mjs` `LG*` cases | Mutation cases: a planted hit, a gutted or re-salted hash file, a blind PDF extractor, a vacuous file listing, a disabled staleness check, dropped aliases and a missing Netlify step must each fail the gate. |

## What is scanned

`dist/**` (the shipped output), every git-tracked file (source, tests, docs, `data/*.json`,
`netlify/edge-functions/chat.ts`, `scripts/meta.md`), the generated `netlify/edge-functions/knowledge-base.json`,
and both root PDFs (also scanned inside `dist/`). File **paths** are scanned too; if a path itself matches, the
report never prints the path of a matched file. A tracked symlink or submodule is itself a finding (the gate cannot read it).

- Text: raw, escape-decoded (HTML numeric and named entities, `\uXXXX`, `\u{...}`, `\xHH`, CSS `\HHHH`, percent-encoding,
  UTF-16 with BOM), and tag-stripped (HTML/SVG) variants. Named entities that are not letters (`&rsquo;`, `&ndash;`,
  `&nbsp;`) are removed so the name joins up; accented-letter entities fold to the base letter.
- PDF: FlateDecode streams are inflated, ToUnicode CMaps are followed per font (direct or indirect font dictionaries),
  `<FEFF...>` hex metadata strings (Info `/Title`, outlines, annotations) are decoded, and both a word-spaced and a
  glyph-glued view are scanned (Chromium writes one glyph per `Tj`, so a name never appears as a string). A PDF that has
  no readable text, uses an undecodable stream filter, is encrypted, uses object streams, or has a Type0/Type3/`/Differences`
  font without ToUnicode **fails the gate** instead of passing.
- gzip/brotli files are unpacked and scanned; zip/Office/other containers fail closed.
- Images and fonts: file names plus embedded printable strings (EXIF/XMP/PNG text chunks, ASCII and UTF-16 at both
  byte offsets). **Pixel content (text drawn into an image) is NOT scanned. OCR is out of scope.** The test prints how
  many images were covered only at that level (currently 300+).

## Matching rules

Terms and text are normalized (NFKD, strip diacritics, drop trademark/superscript marks, fold common Cyrillic/Greek
look-alikes, lowercase, alphanumeric tokens), so spacing, hyphens, case and punctuation variants of one name are the
same string. A hit is any run of consecutive tokens, compacted, whose HMAC is in the denylist (up to 64 tokens; the
character length of the longest term also bounds the window). Terms of 10+ normalized characters are matched as substrings of the compacted document (like the hook; windows start at every token boundary, and at every character position of the file's most normalized text variant), so
plurals ("Foo Holding" in "Foo Holdings"), glued prefixes/suffixes and names split by tags or entities are found. Shorter
terms are matched on whole words only (a trailing plural "s"/"es" is tolerated) to limit false positives. Known gap: "&"
versus "and" (or a dropped word) is not equated; the hook does not equate them either. In PDFs, every window of every term length is checked in the glued character
stream, so a short alias can false-positive there (for example a common word inside "Oxford"); the failure label says
`glued:`. The fix is a longer alias, not an exemption.

Roster mirroring (`activeEntries`): a deal is active unless its `active` key is present and falsy (same default as
`hooks/confidentiality-guard.py`); a blank `context_requires_any` entry unanchors the deal's `context` terms, which then
hit on their own, as in the hook; `context` terms otherwise count only when a requirement term also hits in the same file.
A failure shows a matched file only as `file#<fingerprint><ext>` plus the class (`always`, `context+ctxreq`), never the term or the path (a path can carry the term in a form the path check misses, and CI/Netlify logs are readable). Re-run locally with `LEAK_GATE_SHOW_PATHS=1` to see the paths. The file path is scanned together with the content, so a context term in a file name combines with its anchor in the body.

## When the roster changes (deal added, aliases edited, deal retired)

```bash
node scripts/leak-gate-hashes.mjs           # regenerate; salt is kept so the diff stays small
node scripts/leak-gate-hashes.mjs --check   # exit 1 if the committed file is stale vs the local roster
```

Commit `scripts/leak-gate-hashes.json`. `--new-salt` rotates the salt (old files remain in git history, see below).
Locally, the verify test warns (`LEAK-GATE HASHES ARE STALE ...`) when the committed file no longer matches the roster;
set `LEAK_GATE_STRICT_ROSTER=1` to make that a failure. In CI and on Netlify the roster is absent, so the freshness check
is skipped and the scan runs against the committed hashes. Zero active deals is valid: the file holds no entries and the
scan is a no-op, while the canary tests still prove the scanner works.

## Operational effect: the gate blocks deploys

Because the Netlify build command runs the gate, these fail-closed conditions block **every** build, hotfixes included:
a hit; any `.docx`/`.xlsx`/`.zip` in the tree; an image-only PDF; a PDF with a Type0/Type3/`/Differences` font that has no
ToUnicode, with object streams, or encrypted; a short alias that false-positives in the glued PDF scan; a tracked symlink.
All pass today. When one trips, the output names the file and class (not the term): fix the content, do not weaken the gate.

## Residual risk (read before adding a deal)

1. **Short or guessable terms are brute-forceable from the committed hashes.** The salt is committed (CI must be able to
   verify), so anyone with the repo can run a dictionary of names, addresses and city/street combinations against it.
   - Choice made: the generator never silently drops a term (that would remove protection), and prints a count-only
     warning for any term under 10 normalized characters.
   - Recommendation: treat a short form as *detected but not secret*. Add a distinctive multi-word alias
     (name plus street or city, 15+ characters) as the roster's `always` term where possible, and keep generic words
     in `context` with a rare `context_requires_any` partner. If a deal's only identifier is a short common name, the
     hash file reveals that identity to anyone who guesses it; accept that, or keep that deal out of the hash file and rely
     on the local hook.
   - Measured: with the exact length known (the file stores it), an exhaustive search of a random 5-letter term took about
     35 seconds on one CPU core with this repo's own hash routine; a GPU is orders of magnitude faster. Treat anything under
     about 10 characters as recoverable by anyone with the repo.
   - **Default once any deal is active: keyed mode.** Generate with `LEAK_GATE_KEY=<16+ random chars> node scripts/leak-gate-hashes.mjs --keyed`
     and put the same value in the GitHub Actions secrets (exposed as `LEAK_GATE_KEY` to the verify job) and the Netlify
     environment. The hashing salt is then derived from the committed salt AND the secret, so the committed file cannot be
     brute-forced without it. A keyed file fails closed (the test throws) if the variable is missing or wrong, so wire the
     secrets BEFORE merging a keyed file, or the build and deploys break. Unkeyed is acceptable only for
     long, distinctive aliases. The generator warns when an active deal is unkeyed, and a dry scan of `dist/` and every tracked file reports counts of
     files the new hashes would block.
2. **Metadata leaks.** The file lists each term's normalized length and kind. Generic `context` and `ctxreq` words are
   labelled, which makes them the easiest targets; the same hash appearing under two kinds shows one term is in both;
   the entry count shows how many terms a deal has; `roster_digest` lets someone confirm a guessed full set.
3. **Git history is forever.** Rotating the salt or retiring a deal does not remove old hash files from history, so a
   retired deal stays brute-forceable from past commits. Do not rely on rotation to "unpublish".
4. **Blind spots:** bidirectionally reversed text and other visual-order tricks; pixel text in images; base64 or data-URI payloads; a short (under 10 char) term glued onto adjacent
   letters; text assembled at runtime by script; Windows-1252/other non-UTF-8 text files with non-ASCII letters;
   homoglyphs outside the folded sets; fonts with unusual PDF encodings (these fail closed when detected).
5. **History and the push path are not scanned.** The gate covers the final tree. Commit messages, branch names and
   PR text are protected only by the machine-local hook and pre-push scan.
6. **Staleness.** Nothing in CI can tell that the roster gained a deal after the last generation. The local freshness
   warning and the roster owner re-running the generator are the control.

## Narrowing and bypass guards

The test module throws if it is run with a name/skip/only filter (`--test-name-pattern`, `--test-skip-pattern`, `--test-only`, via the command line or `NODE_OPTIONS`), because that would pass while running one test. `netlify.toml` may not contain any `context` key or table, more than one `command`, `NODE_OPTIONS`, or `LEAK_GATE_FAST`; the test parses it. `LEAK_GATE_FAST=1` skips the slow real-tree scan and exists only for the mutation runner. A Netlify UI environment override cannot be seen from the repo: keep `NODE_OPTIONS` and `LEAK_GATE_FAST` out of the site's environment variables.

## Before activating a deal

Activation can block more files than expected, especially with short or generic terms. A simulated activation with two short
whole-word terms blocked 12 files (6 in `dist/`, 6 tracked sources), 8 of them through image metadata strings. So:

1. Run the generator (it dry-scans `dist/` and every tracked file and prints counts by location, kind and class).
2. Run `LEAK_GATE_SHOW_PATHS=1 npm run test:leak-gate` locally to see which files; CI and Netlify logs show only fingerprints.
3. Keyed mode needs `LEAK_GATE_KEY` scoped to Netlify **Builds** and to GitHub Actions. Fork and Dependabot PRs get no secrets, so `verify` fails on them once the file is keyed: test on a deploy preview before committing a keyed file.
4. Lengthen the alias (name plus street/city) rather than excluding files; then wire `LEAK_GATE_KEY` before merging a keyed file.
