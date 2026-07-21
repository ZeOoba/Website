# oxfordra.net — Oxford Realty Advisors Website

Source repository for [oxfordra.net](https://oxfordra.net), the public website for Oxford Realty Advisors (ORA), a private family-office industrial real estate investor. Static multi-page HTML/CSS/JS site with a handful of Netlify Functions for form handling and a chat assistant, deployed to Netlify.

## Repo layout

The repo root mixes **public site content** with **internal tooling**. Deploys never publish the raw root — `scripts/build-dist.mjs` assembles an allowlisted copy into `dist/`, which is what Netlify actually serves. This is a deliberate boundary: a new file must be explicitly added to the allowlist in `build-dist.mjs` before it ships, so nothing leaks onto the live site by accident.

```
├── *.html                  Public pages (index, about, portfolio, contact, ...)
├── *.css / *.js            Shared styles and client-side scripts
├── assets/, images/, fonts/  Static site assets (copied verbatim to dist/)
├── markets/                 Per-market landing pages (Columbus OH, Maryland, ...)
├── resources/                Seller-focused guide pages (1031 exchange, valuation, ...)
├── netlify/
│   ├── functions/            Netlify Functions (forms, broker OM intake, lead notify)
│   │   └── _shared/          Shared helpers (Graph API auth/mail/files, validation, scoring)
│   └── edge-functions/       Edge function for the /api/chat assistant + its knowledge base
├── scripts/
│   ├── build-dist.mjs         Assembles dist/ for deploy (see below)
│   ├── build-kb.mjs            Builds the chat assistant's knowledge base
│   ├── eval-chat.mjs           Runs the chat assistant eval suite (see evals/)
│   ├── netlify-guard.js        Blocks indirected/obfuscated `netlify deploy --prod` calls
│   ├── patch-netlify-shim.js   postinstall hook wiring netlify-guard.js into netlify-cli's bin
│   └── meta.md                 Canonical firm facts fed into the chat assistant's knowledge base
├── tests/functions/            node:test unit tests for netlify/functions/
├── evals/                      Chat assistant eval fixtures + dated result runs
├── dist/                       BUILD OUTPUT — git-ignored, assembled by build-dist.mjs
├── _headers                    Netlify response headers (CSP, caching, HSTS, preloads)
├── _redirects                  Netlify redirects (legacy Squarespace/Wix paths, non-www enforcement)
├── netlify.toml                Netlify build/publish/functions config
├── sitemap.xml, robots.txt, llms.txt   Search + LLM-crawler discovery files
└── docs/superpowers/            Session-local planning artifacts — git-ignored, not site content
```

## Local development

```bash
npm install        # installs netlify-cli (pinned version) + deps; postinstall wires netlify-guard.js
node scripts/build-dist.mjs   # assemble dist/ locally to inspect exactly what would ship
```

There is no site build step beyond assembling `dist/` — pages are hand-authored static HTML. `npm install` pins `netlify-cli` to a tested version so deploys resolve a local install rather than depending on `npx`'s evictable cache.

## Testing

Unit tests for the Netlify Functions live in `tests/functions/` and use Node's built-in test runner (`node:test`, no framework dependency):

```bash
node --test tests/functions/
```

`application-script.file-size.test.js` at the repo root guards the size of the hand-written DOM script rather than testing exports (it has none — it's a DOM IIFE).

The chat assistant has a separate eval harness (`scripts/eval-chat.mjs` against fixtures in `evals/fixtures.json`), with dated result snapshots retained in `evals/`.

## Deployment

Deploys go through Netlify. **Always deploy with `netlify deploy --build`** so `dist/` is rebuilt from source first — never `netlify deploy --dir=.`, which republishes the raw repo root (internal tooling included) instead of the allowlisted `dist/`.

`_headers` and `_redirects` are the source of truth for HTTP headers and redirects; `netlify.toml` intentionally does not duplicate them — it only carries build/publish and function/edge-function routing config.

A merged PR to `main` auto-deploys to production. Production deploys require explicit human confirmation per-PR — see `scripts/netlify-guard.js`, which is wired in via `scripts/patch-netlify-shim.js` (a postinstall hook) to block obfuscated or indirected `netlify deploy --prod` invocations at the process level, regardless of how the calling shell tries to reach it.

## Netlify Functions

| Function | Purpose |
|---|---|
| `chat-lead.js` | Captures leads submitted via the chat assistant |
| `broker-upload-session.js` / `broker-finalize.js` | Broker OM (offering memorandum) upload intake pipeline |
| `broker-score-background.js` / `broker-score-status.js` | Async scoring of submitted broker deals against ORA's buy-box |
| `owner-lead-notify.js` | Notifies on direct-to-owner ("sell your building") lead submissions |
| `tenant-application-processor.js` | Processes tenant lease applications |
| `edge-functions/chat.ts` | Edge function powering the `/api/chat` assistant, backed by `edge-functions/knowledge-base.json` (built by `scripts/build-kb.mjs` from `scripts/meta.md` + site content) |

Shared helpers (Microsoft Graph auth/mail/file access, reCAPTCHA verification, form validation, broker-score engine) live in `netlify/functions/_shared/`.

## Content notes

- `scripts/meta.md` holds canonical firm facts (leadership, markets, deal parameters, contact info) that feed the chat assistant's knowledge base — update it, not individual pages, when firm-level facts change.
- `_redirects` carries permanent 301s from the site's prior Squarespace and Wix incarnations; do not remove these without confirming the old paths are no longer indexed.
- `llms.txt` is a machine-readable summary for LLM crawlers — keep its key-pages list in sync with actual site navigation.

## Related

- `.claude/` — machine-local Claude Code tooling config (`launch.json` is git-ignored; not part of the deployed site)
- `docs/superpowers/` — session planning artifacts, git-ignored, not site content
