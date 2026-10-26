# oxfordra.net — CLAUDE.md

Static multi-page site for Oxford Realty Advisors, deployed to Netlify. Architecture, build flow and test inventory live in `README.md`; this file holds only what an agent must know before editing.

## Commands

- Gate: `npm run verify` (build → leak-gate → jsonld → unit → site → shim → functions). CI runs exactly this; run it before every commit.
- Build: `npm run build` (assembles `dist/`; also runs the listings and portfolio `--check` drift gates). Run once in a fresh checkout before `netlify dev` — `chat.ts` imports the gitignored `knowledge-base.json`.
- Regenerate listings: `npm run build:listings`. Regenerate portfolio pages: `node scripts/build-portfolio.mjs`. Output is committed.
- Local preview: `npm run serve` (port 8788, serves `dist/`).

## Hard invariants

- **Never deploy to production without explicit in-turn permission** (Invariant 2). Merge to `main` triggers a production deploy, so leave merging to Gabriel. Preview-only deploys: `netlify deploy --build`. Never `--dir=.`; the repo root contains internal tooling.
- **Confidential-deal terms must never appear in `dist/`, tracked files, data, edge functions or PDFs** (Invariant 3). The leak gate (`docs/leak-gate.md`) uses a salted-hash denylist. Do not add deal names or terms to any file to "test" it.

## Rules that prevent known failures

- `data/listings.json` and `data/portfolio.json` are the source of truth. Never hand-edit the generated blocks in `listings.js`, `available-space.html`, `portfolio.html` or `properties/*.html`; edit the JSON and regenerate, or the `--check` gate fails the build.
- `_headers` and `_redirects` are the source of truth for headers and redirects; do not duplicate them in `netlify.toml`.
- Inline scripts need a matching CSP hash in `_headers`; `'unsafe-inline'` in `script-src` fails the build.
- `scripts/build-dist.mjs` classifies every root entry as site file or exclusion. A new root file must be added to `SITE_FILES`/`SITE_DIRS` or `EXPECTED_EXCLUSIONS`.
- `tests/site/*.test.mjs` is enumerated by hand in `package.json`. Append any new file to the right script or the coverage guard fails.
- Firm facts come from `scripts/meta.md`; the chat assistant's knowledge base is built from it. Do not invent tenant, deal or financial detail.
- PDFs must keep an extractable text layer (headless Chromium builders in `scripts/*-pdf/`). Never use Microsoft Print to PDF.
