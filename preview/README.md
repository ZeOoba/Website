# Oxford Realty Advisors — Redesign Preview (v1)

This folder hosts an **isolated, non-production preview** of a redesigned, more interactive version of oxfordra.net. It is a static HTML site that loads React + Babel from a CDN at runtime — no build step.

## Status

- **Production site (`oxfordra.net`) is unaffected.** This preview lives on a separate Netlify site and is deployed only from the `preview/redesign-v1` branch.
- **No custom domain** — preview is served from its auto-generated `*.netlify.app` URL only.
- **Branch:** `preview/redesign-v1` (do not merge to `main`).

## Deploy URL

Preview URL: _<populated after first deploy on the separate Netlify site>_

## Local preview

```bash
cd preview
python -m http.server 8000
# open http://localhost:8000
```

## Netlify configuration

`preview/netlify.toml` is scoped to this folder only. The separate Netlify site is configured with:

- **Base directory:** `preview/`
- **Publish directory:** `preview/` (i.e. `.` relative to base)
- **Build command:** _(empty)_
- **Production branch:** `preview/redesign-v1`
- **Custom domain:** _none_

There is no `netlify.toml` at the repo root for this preview — the production site's root `netlify.toml` continues to govern oxfordra.net.

## Teardown

```bash
netlify sites:delete <preview-site-id>
git push origin --delete preview/redesign-v1
git branch -D preview/redesign-v1
```
