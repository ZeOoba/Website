// Mutation catalog for tests/mutation/run.mjs.
//
// Each case breaks a scratch copy of the site on purpose and names the check
// that must catch it. A case is one of:
//   expect: '<substring of a test name>'  the command must exit non-zero AND a
//                                         failing test's name must contain this
//   expect: 'FAIL'                        the command must exit non-zero (plain
//                                         scripts with no test names)
//   expect: 'PASS'                        a legitimate variant; must exit 0
//
// `edits` are [file, fn] pairs relative to the repo root. fn receives the
// current text (null if the file does not exist) and returns the new text.
// Files under dist/ are edited after the copy is built, so `nav` and `verify`
// cases test the served output. An anchor that no longer matches throws, and
// the runner reports it as STALE rather than as a pass.
//
// When a check is added or tightened, add the breakage it exists to catch here.

import { hmac, compact, effectiveSalt, selfcheckOf } from '../../scripts/lib/leak-gate.mjs';

// Rewrite the committed leak-gate denylist to hold one entry (or none for null),
// keyed with the file's own salt.
const plantDenylist = (phrase) => (s) => {
  const f = JSON.parse(s);
  // Keyed files hash with the key-derived salt (LEAK_GATE_KEY must be in the environment, as in CI).
  const eff = effectiveSalt(f.salt, f.keyed === true);
  f.entries = phrase ? [{ kind: 'always', h: hmac(eff, compact(phrase)), len: compact(phrase).length }] : [];
  f.selfcheck = selfcheckOf(f, eff);
  return JSON.stringify(f, null, 2) + '\n';
};

// Delete the first line matching a pattern, whatever the checkout's line endings (the self-hosted runner is Windows, CRLF).
const dropLine = (re) => (s) => {
  if (s === null || !re.test(s)) throw new Error(`anchor not found: ${re}`);
  return s.replace(re, '');
};

export const sub = (find, repl) => (s) => {
  if (s === null || !s.includes(find)) throw new Error(`anchor not found: ${find}`);
  return s.replace(find, repl);
};

// Replace the first sitemap <lastmod> whatever its date. Anchoring on a literal date
// (it was 2026-08-12) goes STALE the moment that page's lastmod is legitimately bumped.
const LASTMOD_RE = /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/;
const subLastmod = (repl) => (s) => {
  if (s === null || !LASTMOD_RE.test(s)) throw new Error('anchor not found: any <lastmod>');
  return s.replace(LASTMOD_RE, (m) => (typeof repl === 'function' ? repl(m) : repl));
};
const stripJsonLd =(s) => s.replace(/<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, '');
const BTN_BASE = '.nav__mobile-btn{display:none;background:none;border:0;cursor:pointer;padding:8px}';
const moveHamburgerIntoLinks = (s) => {
  const m = s.match(/<button class="nav__mobile-btn"[\s\S]*?<\/button>\s*/);
  if (!m) throw new Error('anchor not found: nav__mobile-btn button');
  return s.replace(m[0], '').replace('<div class="nav__links">', '<div class="nav__links">' + m[0]);
};
const moveLeasingHandlerAboveForm = (comment = '') => (s) => {
  const start = s.indexOf('<script>', s.indexOf('id="leasingSuccess"'));
  const end = s.indexOf('</script>', start) + 9;
  const formAt = s.indexOf('<form method="POST" name="leasing-inquiry"');
  if (start < 0 || formAt < 0) throw new Error('anchor not found: leasing handler or form');
  const block = s.slice(start, end).replace('<script>', '<script>' + comment);
  return s.slice(0, formAt) + block + '\n' + s.slice(formAt, start) + s.slice(end);
};

export const CASES = [
  // --- seo.test.mjs WP-n: 2026-09-25 website-perfection audit -------------------
  { id: 'W1', what: 'Indianapolis reappears as a broker-form market option', edits: [['for-brokers.html', sub('<option value="Other">Other</option>', '<option value="Indianapolis">Indianapolis</option><option value="Other">Other</option>')]], run: 'seo', expect: 'Indianapolis' },
  { id: 'W2', what: 'a LinkedIn origin sneaks back into the CSP', edits: [['_headers', sub("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js https://netlify-rum.netlify.app;", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js https://snap.licdn.com https://netlify-rum.netlify.app;")]], run: 'seo', expect: 'LinkedIn' },
  { id: 'W3', what: "CSP loses object-src 'none'", edits: [['_headers', sub("; object-src 'none'", '')]], run: 'seo', expect: 'injection-hardening' },
  { id: 'W3b', what: 'X-XSS-Protection flips back to the legacy auditor', edits: [['_headers', sub('X-XSS-Protection: 0', 'X-XSS-Protection: 1; mode=block')]], run: 'seo', expect: 'injection-hardening' },
  { id: 'W4', what: 'the logo "|" glyph returns as SVG text on one page', edits: [['about.html', sub('<rect x="257" y="10" width="2" height="38" opacity="0.5"/>', '<text x="252" y="42" font-size="40" opacity="0.5">|</text>')]], run: 'seo', expect: 'nav logo' },
  { id: 'W5', what: '#mobileNav demoted to a <div> (both tags, so containers stay balanced)', edits: [['contact.html', (s) => { const i = s.indexOf('<nav class="nav__mobile" id="mobileNav"'); if (i < 0) throw new Error('anchor not found: mobileNav'); const j = s.indexOf('</nav>', i); return s.slice(0, i) + '<div' + s.slice(i + 4, j) + '</div>' + s.slice(j + 6); }]], run: 'seo', expect: 'mobile navigation panel' },
  { id: 'W6', what: 'a track-record expander loses its aria-controls', edits: [['track-record.html', sub(' aria-controls="track-details-3"', '')]], run: 'seo', expect: 'aria-controls' },
  { id: 'W7', what: 'slider :focus-visible rule removed from styles.css', edits: [['styles.css', sub('.basis-engine__slider:focus-visible{outline:2px solid var(--gold);outline-offset:4px}', '')]], run: 'seo', expect: 'range slider' },
  { id: 'W8', what: 'privacy loses its inline skip-link focus rule', edits: [['privacy.html', sub('.skip-link:focus{top:0!important}', '')]], run: 'seo', expect: 'skip link' },
  { id: 'W9', what: 'a title grows past 60 characters', edits: [['contact.html', sub('<title>Contact: Submit a Deal or Inquiry | Oxford Realty Advisors</title>', '<title>Contact: Submit a Deal, Inquiry or Question | Oxford Realty Advisors</title>')]], run: 'seo', expect: '60 characters' },
  { id: 'W10', what: 'llms.txt drops the Kansas City market', edits: [['llms.txt', (s) => s.split('Kansas City').join('KC')]], run: 'seo', expect: 'llms.txt' },
  { id: 'W11', what: 'meta.md reintroduces the 2008 ownership distinction', edits: [['scripts/meta.md', sub('Founded 2005;', 'Founded 2005 (advisory practice); shifted to direct ownership in 2008;')]], run: 'seo', expect: 'founding claim' },
  { id: 'W12', what: 'an image nothing references lands in images/', edits: [['images/zz-orphan.png', () => 'not really a png']], run: 'seo', expect: 'images/' },
  { id: 'W13', what: 'script.js submit handler loses its defaultPrevented guard', edits: [['script.js', (s) => { const t = s.replace(/if \(event\.defaultPrevented\) \{\s*return;\s*\}/, ''); if (t === s) throw new Error('anchor not found: defaultPrevented guard'); return t; }]], run: 'seo', expect: 'generic validator respects' },
  { id: 'W14', what: 'the Netlify RUM collector host drops out of connect-src (beacon blocked again)', edits: [['_headers', sub(' https://ingesteer.services-prod.nsvcs.net;', ';')]], run: 'seo', expect: 'RUM collector host' },
  { id: 'W14b', what: 'the RUM allowance is widened to a *.nsvcs.net wildcard', edits: [['_headers', sub('https://ingesteer.services-prod.nsvcs.net;', 'https://*.nsvcs.net;')]], run: 'seo', expect: 'RUM collector host' },
  { id: 'W14c', what: 'the RUM host is also allowed as a script source', edits: [['_headers', sub('https://netlify-rum.netlify.app; style-src', 'https://netlify-rum.netlify.app https://ingesteer.services-prod.nsvcs.net; style-src')]], run: 'seo', expect: 'RUM collector host' },
  { id: 'W14d', what: 'the host is moved into a second connect-src while the real one drops it (browsers ignore the repeat)', edits: [['_headers', sub(" https://ingesteer.services-prod.nsvcs.net; frame-src 'self' https://www.google.com/recaptcha/;", "; frame-src 'self' https://www.google.com/recaptcha/; connect-src https://ingesteer.services-prod.nsvcs.net;")]], run: 'seo', expect: 'RUM collector host' },
  { id: 'W15', what: 'a Columbus market-snapshot figure loses its source link', edits: [['markets/columbus-oh.html', sub('<li id="mkt-3">', '<li id="mkt-3x">')]], run: 'seo', expect: 'market snapshot figure cites' },
  { id: 'WP1', what: 'legitimate: a second rect in the logo is fine', edits: [['about.html', sub('<rect x="257" y="10" width="2" height="38" opacity="0.5"/>', '<rect x="257" y="10" width="2" height="38" opacity="0.5"/><rect x="0" y="0" width="0" height="0"/>')]], run: 'seo', expect: 'PASS' },

  // --- netlify-forms.test.mjs --------------------------------------------------
  { id: 'F1', what: 'leasing handler looks up a form id that does not exist', edits: [['tenant-resources.html', sub("getElementById('leasingForm')", "getElementById('leasingFormX')")]], run: 'forms', expect: 'binds to the form' },
  { id: 'F2', what: 'leasing handler moved above the form it binds', edits: [['tenant-resources.html', moveLeasingHandlerAboveForm()]], run: 'forms', expect: 'binds to the form' },
  { id: 'F3', what: 'leasing handler touches a renamed #leasingError', edits: [['tenant-resources.html', sub('id="leasingError"', 'id="leasingErr"')]], run: 'forms', expect: 'binds to the form' },
  { id: 'F4', what: 'handler above the form, "DOMContentLoaded" only in a JS comment', edits: [['tenant-resources.html', moveLeasingHandlerAboveForm('\n// runs on DOMContentLoaded (it does not)')]], run: 'forms', expect: 'binds to the form' },
  { id: 'F5', what: 'contact form loses data-netlify and form-name', edits: [['contact.html', (s) => sub(' data-netlify="true"', '')(sub('<input type="hidden" name="form-name" value="contact">', '')(s))]], run: 'forms', expect: 'pinned set' },
  { id: 'F6', what: 'contact form commented out', edits: [['contact.html', (s) => s.replace(/(<form method="POST" name="contact"[\s\S]*?<\/form>)/, '<!--$1-->')]], run: 'forms', expect: 'pinned set' },
  { id: 'F7', what: 'an unpinned Netlify form appears in assets/', edits: [['assets/quote.html', () => '<form name="quote" data-netlify="true"><input type="hidden" name="form-name" value="quote"></form>']], run: 'forms', expect: 'pinned set' },

  // --- JSON-LD: verify-jsonld.mjs over dist/, and the site-integrity type pins --
  { id: 'J1', what: 'dist: id-first JSON-LD tag holding broken JSON', edits: [['dist/markets/maryland.html', sub('<script type="application/ld+json">', '<script id="x" type="application/ld+json">{BROKEN')]], run: 'verify', expect: 'FAIL' },
  { id: 'J2', what: "dist: contact's only JSON-LD block commented out", edits: [['dist/contact.html', (s) => s.replace(/(<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>)/i, '<!--$1-->')]], run: 'verify', expect: 'FAIL' },
  { id: 'J3', what: 'all JSON-LD removed from markets/columbus-oh', edits: [['markets/columbus-oh.html', stripJsonLd]], run: 'integ', expect: 'JSON-LD types' },
  { id: 'J4', what: 'all JSON-LD removed from markets/index', edits: [['markets/index.html', stripJsonLd]], run: 'integ', expect: 'JSON-LD types' },
  { id: 'J5', what: 'all JSON-LD removed from tenant-resources', edits: [['tenant-resources.html', stripJsonLd]], run: 'integ', expect: 'JSON-LD types' },
  { id: 'J6', what: 'FAQPage block commented out', edits: [['tenant-resources.html', (s) => { const i = s.indexOf('<script type="application/ld+json">', s.indexOf('FAQPage') - 400); const j = s.indexOf('</script>', s.indexOf('FAQPage')) + 9; if (i < 0) throw new Error('anchor not found: FAQPage block'); return s.slice(0, i) + '<!--' + s.slice(i, j) + '-->' + s.slice(j); }]], run: 'integ', expect: 'JSON-LD types' },
  { id: 'J7', what: 'FAQPage block retyped application/ld+json5', edits: [['tenant-resources.html', (s) => s.replace(/<script type="application\/ld\+json">(?=[\s\S]{0,300}FAQPage)/, '<script type="application/ld+json5">')]], run: 'integ', expect: 'JSON-LD types' },
  { id: 'J8', what: 'the /terms <url> commented out of sitemap.xml', edits: [['sitemap.xml', (s) => s.replace(/(<url><loc>https:\/\/oxfordra\.net\/terms<\/loc>[\s\S]*?<\/url>)/, '<!--$1-->')]], run: 'integ', expect: 'JSON-LD types' },
  { id: 'JP1', what: '"<!--" inside a JSON-LD string, a real comment later', edits: [['tenant-resources.html', sub('"@type": "FAQPage"', '"@type": "FAQPage", "description": "see <!-- note"')]], run: 'integ', expect: 'PASS' },
  { id: 'JP2', what: 'an empty "<!-->" comment before the JSON-LD blocks', edits: [['tenant-resources.html', sub('<script type="application/ld+json">', '<!--><script type="application/ld+json">')]], run: 'integ', expect: 'PASS' },

  // --- site-integrity.test.mjs: structured data, anchors, images, markup -------
  { id: 'I1', what: 'ItemList numberOfItems 3 -> 4', edits: [['markets/index.html', sub('"numberOfItems": 3', '"numberOfItems": 4')]], run: 'integ', expect: 'ItemList' },
  { id: 'I2', what: 'BreadcrumbList positions 1, 7', edits: [['about.html', sub('"position": 2', '"position": 7')]], run: 'integ', expect: 'BreadcrumbList' },
  { id: 'I3', what: 'a linked #fragment target removed', edits: [['for-brokers.html', sub('<section id="broker-network"', '<section')]], run: 'integ', expect: '#fragment' },
  { id: 'I4', what: 'link to /contact#contact, which is only a form NAME', edits: [['about.html', sub('</main>', '<a href="/contact#contact">x</a></main>')]], run: 'integ', expect: '#fragment' },
  { id: 'I5', what: 'og:image points at a missing file', edits: [['index.html', sub('content="https://oxfordra.net/images/og-image.png"', 'content="https://oxfordra.net/images/og-image-missing.png"')]], run: 'integ', expect: 'og:image' },
  { id: 'I6', what: 'og:image:width 800 -> 801', edits: [['for-brokers.html', (s) => s.replace(/(property="og:image:width" content=")800"/, '$1801"')]], run: 'integ', expect: 'og:image' },
  { id: 'I7', what: 'a second <h1>', edits: [['about.html', sub('</h1>', '</h1><h1>Duplicate</h1>')]], run: 'integ', expect: '<h1>' },
  { id: 'I8', what: 'a </section> dropped', edits: [['index.html', sub('</section>', '')]], run: 'integ', expect: 'balanced' },
  { id: 'I9', what: 'an extra </section>', edits: [['contact.html', sub('</main>', '</section></main>')]], run: 'integ', expect: 'balanced' },
  { id: 'I10', what: 'srcset names a missing file', edits: [['portfolio.html', sub('20-9050-red-branch-exterior-480w.webp 480w', '20-9050-red-branch-exterior-999w.webp 480w')]], run: 'integ', expect: 'srcset' },
  { id: 'I11', what: 'srcset w descriptor disagrees with the image', edits: [['portfolio.html', sub('20-9050-red-branch-exterior-480w.webp 480w', '20-9050-red-branch-exterior-480w.webp 500w')]], run: 'integ', expect: 'srcset' },
  { id: 'I12', what: 'headshot <img src> renamed to a missing file', edits: [['about.html', sub('src="/images/eric-goldberg-headshot.jpg"', 'src="/images/eric-goldberg-headshot.MISSING"')]], run: 'integ', expect: 'image preload href exists' },
  { id: 'IP1', what: 'link to /contact#contactForm (name precedes id on the form)', edits: [['about.html', sub('</main>', '<a href="/contact#contactForm">x</a></main>')]], run: 'integ', expect: 'PASS' },
  { id: 'IP2', what: 'link to the Overview PDF with #page=2', edits: [['about.html', sub('</main>', '<a href="/Oxford-Realty-Advisors-Overview.pdf#page=2">x</a></main>')]], run: 'integ', expect: 'PASS' },
  { id: 'IP3', what: 'host-only link https://oxfordra.net#main-content from a nested page', edits: [['markets/index.html', sub('</main>', '<a href="https://oxfordra.net#main-content">x</a></main>')]], run: 'integ', expect: 'PASS' },
  { id: 'IP4', what: 'available-space ItemList with zero elements (everything leased)', edits: [['available-space.html', (s) => s.replace(/("@type": "ItemList",[\s\S]*?"itemListElement": )\[[\s\S]*?\n\s*\]/, '$1[]')]], run: 'integ', expect: 'PASS' },
  { id: 'IP5', what: 'percent-encoded img src (/images/og%2Dimage.png)', edits: [['about.html', sub('</main>', '<img src="/images/og%2Dimage.png" alt="" width="1" height="1"></main>')]], run: 'integ', expect: 'PASS' },

  // --- sitemap lastmod ------------------------------------------------------------
  { id: 'S1', what: 'lastmod in the future', edits: [['sitemap.xml', subLastmod('<lastmod>2099-12-31</lastmod>')]], run: 'integ', expect: 'lastmod' },
  { id: 'S2', what: 'lastmod month 23', edits: [['sitemap.xml', subLastmod('<lastmod>2026-23-09</lastmod>')]], run: 'integ', expect: 'lastmod' },
  { id: 'S3', what: 'lastmod unpadded', edits: [['sitemap.xml', subLastmod('<lastmod>2026-9-3</lastmod>')]], run: 'integ', expect: 'lastmod' },
  { id: 'S4', what: 'lastmod 2026-02-30 (not a calendar date)', edits: [['sitemap.xml', subLastmod('<lastmod>2026-02-30</lastmod>')]], run: 'integ', expect: 'lastmod' },
  { id: 'S5', what: 'a <url> with two lastmods', edits: [['sitemap.xml', subLastmod((m) => m + '<lastmod>2026-08-13</lastmod>')]], run: 'integ', expect: 'lastmod' },

  // --- internal links and asset versions ----------------------------------------
  { id: 'L1', what: 'link to /contactx (no such page)', edits: [['about.html', sub('href="/contact"', 'href="/contactx"')]], run: 'integ', expect: 'ships in dist' },
  { id: 'L2', what: 'link to /package.json (in the repo, never ships)', edits: [['about.html', sub('</main>', '<a href="/package.json">x</a></main>')]], run: 'integ', expect: 'ships in dist' },
  { id: 'L3', what: 'one page requests script.js at a different ?v=', edits: [['about.html', (s) => { const t = s.replace(/src="\/script\.js\?v=(\d+)"/, (m, v) => `src="/script.js?v=${Number(v) + 1}"`); if (t === s) throw new Error('anchor not found: script.js?v='); return t; }]], run: 'integ', expect: 'one ?v=' },
  { id: 'LP1', what: 'http://www. spelling, a ?query-only link, and an /api/* rewrite', edits: [['about.html', sub('</main>', '<a href="http://www.oxfordra.net/about">a</a><a href="?ref=x">b</a><a href="/api/broker-finalize">c</a></main>')]], run: 'integ', expect: 'PASS' },

  // --- mobile nav: static cascade (integ) and rendered (nav) ---------------------
  { id: 'N1', what: 'hamburger button removed', edits: [['index.html', (s) => s.replace(/<button class="nav__mobile-btn"[\s\S]*?<\/button>/, '')]], run: 'integ', expect: 'hamburger' },
  { id: 'N2', what: 'hamburger never shown at the breakpoint', edits: [['markets/maryland.html', sub('.nav__mobile-btn{display:block}', '')]], run: 'integ', expect: 'hamburger' },
  { id: 'N3', what: '#mobileNav panel renamed', edits: [['privacy.html', sub('id="mobileNav"', 'id="mobileNavGone"')]], run: 'integ', expect: 'hamburger' },
  { id: 'N4', what: 'base hide rule moved after the media block', edits: [['about.html', (s) => sub('</style>', BTN_BASE + '</style>')(sub(BTN_BASE, '')(s))]], run: 'integ', expect: 'hamburger' },
  { id: 'N5', what: 'higher-specificity hide .nav .nav__mobile-btn', edits: [['about.html', sub('</style>', '.nav .nav__mobile-btn{display:none}</style>')]], run: 'integ', expect: 'hamburger' },
  { id: 'N6', what: 'later @media screen and (max-width:1279px) hide', edits: [['about.html', sub('</style>', '@media screen and (max-width:1279px){.nav__mobile-btn{display:none}}</style>')]], run: 'integ', expect: 'hamburger' },
  { id: 'N7', what: 'base hide made !important', edits: [['about.html', sub(BTN_BASE, BTN_BASE.replace('display:none', 'display:none!important'))]], run: 'integ', expect: 'hamburger' },
  { id: 'N8', what: 'script.js loaded from /js/script.js', edits: [['about.html', (s) => { const t = s.replace(/src="\/script\.js\?v=(\d+)"/, 'src="/js/script.js?v=$1"'); if (t === s) throw new Error('anchor not found: script.js?v='); return t; }]], run: 'integ', expect: 'hamburger' },
  { id: 'N9', what: 'hamburger moved inside .nav__links', edits: [['about.html', moveHamburgerIntoLinks]], run: 'integ', expect: 'hamburger' },
  { id: 'N10', what: 'every panel link href="#"', edits: [['about.html', (s) => s.replace(/(<nav class="nav__mobile" id="mobileNav"[^>]*>)([\s\S]*?)(<\/nav>)/, (m, o, body, c) => o + body.replace(/href="[^"]*"/g, 'href="#"') + c)]], run: 'integ', expect: 'hamburger' },
  { id: 'N11', what: 'range-syntax hide (1024px<=width<=1279px)', edits: [['about.html', sub('</style>', '@media (1024px<=width<=1279px){.nav__mobile-btn{display:none}}</style>')]], run: 'integ', expect: 'hamburger' },
  { id: 'N12', what: 'hide via .nav__mobile-btn:not(.x)', edits: [['about.html', sub('</style>', '@media (max-width:1279px){.nav__mobile-btn:not(.x){display:none}}</style>')]], run: 'integ', expect: 'hamburger' },
  { id: 'N13', what: 'hide nested in @supports', edits: [['about.html', sub('</style>', '@supports (display:grid){@media (max-width:1279px){.nav__mobile-btn{display:none}}}</style>')]], run: 'integ', expect: 'hamburger' },
  { id: 'N14', what: 'hide in <style media="(max-width:1279px)">', edits: [['about.html', sub('</head>', '<style media="(max-width:1279px)">.nav__mobile-btn{display:none!important}</style></head>')]], run: 'integ', expect: 'hamburger' },
  { id: 'NP1', what: 'show rule written @media screen and (max-width:60em)', edits: [['application-received.html', sub('@media(max-width:960px){.nav__mobile-btn{display:block}', '@media screen and (max-width:60em){.nav__mobile-btn{display:block}')]], run: 'integ', expect: 'PASS' },

  { id: 'R1', what: 'rendered: higher-specificity hide', edits: [['dist/about.html', sub('</style>', '.nav .nav__mobile-btn{display:none}</style>')]], run: 'nav', expect: 'reachable' },
  { id: 'R2', what: 'rendered: later @media screen and (max-width:1279px) hide', edits: [['dist/about.html', sub('</style>', '@media screen and (max-width:1279px){.nav__mobile-btn{display:none}}</style>')]], run: 'nav', expect: 'reachable' },
  { id: 'R3', what: 'rendered: base hide made !important', edits: [['dist/about.html', sub(BTN_BASE, BTN_BASE.replace('display:none', 'display:none!important'))]], run: 'nav', expect: 'reachable' },
  { id: 'R4', what: 'rendered: hamburger inside .nav__links', edits: [['dist/about.html', moveHamburgerIntoLinks]], run: 'nav', expect: 'reachable' },
  { id: 'R5', what: "rendered: 404's scrolling .site-nav__links hidden on phones", edits: [['dist/404.html', sub('</style>', '@media(max-width:640px){.site-nav__links{display:none}}</style>')]], run: 'nav', expect: 'reachable' },
  { id: 'R6', what: 'rendered: script.js menu handler disabled', edits: [['dist/script.js', sub('if (toggleButton && panel) {', 'if (false && toggleButton && panel) {')]], run: 'nav', expect: 'reachable' },
  { id: 'R7', what: 'rendered: range-syntax hide (1024-1279)', edits: [['dist/about.html', sub('</style>', '@media (1024px<=width<=1279px){.nav__mobile-btn{display:none}}</style>')]], run: 'nav', expect: 'reachable' },
  { id: 'R8', what: 'rendered: hamburger opacity:0', edits: [['dist/about.html', sub('</style>', '.nav__mobile-btn{opacity:0}</style>')]], run: 'nav', expect: 'reachable' },
  { id: 'R9', what: 'rendered: links parked off-screen, hamburger hidden', edits: [['dist/about.html', sub('</style>', '.nav__links{display:flex!important;position:absolute;left:-9999px}.nav__mobile-btn{display:none!important}</style>')]], run: 'nav', expect: 'reachable' },
  { id: 'R10', what: 'rendered: menu opens transparent', edits: [['dist/about.html', sub('</style>', '.nav__mobile.is-open{opacity:0}</style>')]], run: 'nav', expect: 'reachable' },

  // --- upload budgets (rendered, tests/site/upload-budget.test.mjs) -----------------
  { id: 'UB1', what: 'rendered: application-script.js stops flagging an over-cap file (only script.js\'s 10 MB check is left)', edits: [['dist/application-script.js', sub("input.setCustomValidity('File exceeds the per-field limit.');", '')]], run: 'budget', expect: 'over its 1.5 MB cap' },
  { id: 'UB2', what: "rendered: driver's-licence cap raised past script.js's 10 MB cap", edits: [['dist/application-script.js', sub("'upload-drivers-license': 1.5 * 1024 * 1024", "'upload-drivers-license': 100 * 1024 * 1024")]], run: 'budget', expect: 'over its 1.5 MB cap' },
  { id: 'UB3', what: 'rendered: the submit handler no longer runs validateStep', edits: [['dist/application-script.js', sub('if(!validateStep(TOTAL_STEPS)){ e.preventDefault(); return; }', '')]], run: 'budget', expect: 'over its 1.5 MB cap' },

  // --- Available Space UI (rendered, tests/site/listings-ui.test.mjs) -----------------
  { id: 'LS1', what: 'size filter goes back to summing all units against the minimum (the shipped bug)', edits: [['dist/listings.js', sub('return hi >= min && lo <= max;', 'return p.units.reduce(function (s, x) { return s + x.sf; }, 0) >= min && lo <= max;')]], run: 'listings', expect: 'shipped bug pinned' },
  { id: 'LS2', what: 'stats bar totals use each unit\'s minimum instead of its maximum', edits: [['dist/listings.js', sub('return us + (u.sfMax || u.sf);', 'return us + u.sf;')]], run: 'listings', expect: 'stats bar' },
  { id: 'LS3', what: 'size ascending sorts descending', edits: [['dist/listings.js', sub('return totalSF(a) - totalSF(b);', 'return totalSF(b) - totalSF(a);')]], run: 'listings', expect: 'sorting' },
  { id: 'LS4', what: 'Escape no longer closes the detail overlay', edits: [['dist/listings.js', sub("if (e.key === 'Escape') closeDetail();", '')]], run: 'listings', expect: 'detail overlay' },
  { id: 'LS5', what: 'the detail overlay stops trapping Tab focus', edits: [['dist/listings.js', sub("document.addEventListener('keydown', detailKeydownTrap);", '')]], run: 'listings', expect: 'detail overlay' },
  { id: 'LS6', what: 'Clear all forgets to empty the search box', edits: [['dist/listings.js', sub("el('searchInput').value = '';", '')]], run: 'listings', expect: 'search matches' },

  // --- CSP script-src hashes ----------------------------------------------------------
  { id: 'CS1', what: 'an injected inline script (the XSS the policy exists to stop) is on a served page', edits: [['dist/about.html', sub('</body>', '<script>window.__pwned=1</script></body>')]], run: 'cspPages', expect: 'no script-src violation' },
  { id: 'CS2', what: 'an inline script is edited but the hashes are not regenerated', edits: [['for-brokers.html', sub("var form = document.getElementById('brokerForm');", "var form = document.getElementById('brokerForm'); ")]], run: 'csp', expect: 'lists exactly the sha256' },
  { id: 'CS3', what: "'unsafe-inline' is put back into script-src", edits: [['_headers', sub("script-src 'self' ", "script-src 'unsafe-inline' 'self' ")]], run: 'csp', expect: "no 'unsafe-inline'" },
  { id: 'CS4', what: 'an inline onclick handler is added to a page', edits: [['about.html', sub('</main>', '<button onclick="go()">x</button></main>')]], run: 'csp', expect: 'cannot allow' },
  { id: 'CS5', what: 'a hash is dropped from _headers', edits: [['_headers', (s) => { const t = s.replace(/'sha256-[^']+' /, ''); if (t === s) throw new Error('anchor not found: a sha256 source'); return t; }]], run: 'csp', expect: 'lists exactly the sha256' },
  { id: 'CS7', what: 'the build fails closed (and leaves no dist/) when an inline script changed without regenerating the hashes', edits: [['for-brokers.html', sub("var form = document.getElementById('brokerForm');", "var form = document.getElementById('brokerForm'); ")]], run: 'buildFailsClean', expect: 'PASS' },
  { id: 'CS8', what: "script-src is widened back to the whole unpkg.com host", edits: [['_headers', sub('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js https://netlify-rum.netlify.app;', 'https://unpkg.com https://netlify-rum.netlify.app;')]], run: 'csp', expect: 'unpkg.com is allowed only for the exact files' },
  { id: 'CS9', what: 'a page starts loading another unpkg file the CSP does not allow', edits: [['available-space.html', sub('</body>', '<script src="https://unpkg.com/other-lib@1.0.0/dist/x.js"></script></body>')]], run: 'csp', expect: 'unpkg.com is allowed only for the exact files' },
  { id: 'CS6', what: 'legitimate: a JSON-LD block is edited (data, not executable, needs no hash)', edits: [['about.html', sub('"@type": "Organization"', '"@type": "Organization", "slogan": "x"')]], run: 'csp', expect: 'PASS' },

  // --- build-dist.mjs ---------------------------------------------------------------
  { id: 'B1', what: 'Overview PDF in both SITE_FILES and EXPECTED_EXCLUSIONS', edits: [['scripts/build-dist.mjs', sub("const EXPECTED_EXCLUSIONS = ['application-script.file-size.test.js',", "const EXPECTED_EXCLUSIONS = ['Oxford-Realty-Advisors-Overview.pdf', 'application-script.file-size.test.js',")]], run: 'buildFailsClean', expect: 'PASS' },
  { id: 'BP1', what: 'a dot-file in resources/ does not ship', edits: [['resources/.draft-notes', () => 'private']], run: 'buildNoDotfile', expect: 'PASS' },

  // --- leak-gate.test.mjs (Hard Invariant 3) --------------------------------------
  // The denylist is edited to hold a PUBLIC phrase that the shipped pages really contain,
  // standing in for a roster term, so no deal name is ever involved.
  { id: 'LG1', what: 'a denylisted phrase appears in the shipped pages', edits: [['scripts/leak-gate-hashes.json', plantDenylist('Oxford Realty Advisors')]], run: 'leak', expect: 'no active confidential-deal term' },
  { id: 'LG2', what: 'the hash file is emptied to {} (gate must fail closed, not pass)', edits: [['scripts/leak-gate-hashes.json', () => '{}']], run: 'leak', expect: 'no active confidential-deal term' },
  { id: 'LG5', what: 'the salt is swapped for another valid-looking one (entries no longer match)', edits: [['scripts/leak-gate-hashes.json', (t) => t.replace(/"salt": "[0-9a-f]{64}"/, '"salt": "' + 'ab'.repeat(32) + '"')]], run: 'leak', expect: 'no active confidential-deal term' },
  { id: 'LG6', what: 'the tracked-file listing silently returns nothing (scan would be vacuous)', edits: [['scripts/lib/leak-gate.mjs', sub("    return execFileSync('git', ['ls-files', '-z']", "    return [] ?? execFileSync('git', ['ls-files', '-z']")]], run: 'leak', expect: 'no active confidential-deal term' },
  { id: 'LG7', what: 'the local roster staleness check is disabled (always "absent")', edits: [['scripts/leak-gate-hashes.mjs', sub("if (!existsSync(p)) return { state: 'absent', active: 0 };", "return { state: 'absent', active: 0 };")]], run: 'leakFast', expect: 'roster staleness is detected' },
  { id: 'LG8', what: 'roster aliases are no longer hashed', edits: [['scripts/lib/leak-gate.mjs', dropLine(/ *for \(const t of strs\(deal\.aliases\)\)[^\n]*\r?\n/)]], run: 'leakFast', expect: 'aliases are hashed' },
  { id: 'LG9', what: 'the gate step is removed from the Netlify build command', edits: [['netlify.toml', sub(' && node --test tests/site/leak-gate.test.mjs', '')]], run: 'leakFast', expect: 'Netlify build command' },
  { id: 'LG10', what: 'findings name the matched file by its real path again', edits: [['scripts/lib/leak-gate.mjs', sub('return showPaths ? relPath : `file#', 'return true ? relPath : `file#')]], run: 'leakFast', expect: 'round-3 regressions' },
  { id: 'LG11', what: 'the generator ignores --keyed', edits: [['scripts/leak-gate-hashes.mjs', sub("const keyed = process.argv.includes('--keyed') ||", "const keyed = false && process.argv.includes('--keyed') ||")]], run: 'leakFast', expect: 'generator CLI' },
  { id: 'LG12', what: 'the generator dry scan is removed', edits: [['scripts/leak-gate-hashes.mjs', sub('const dry = dryScan(file);', 'const dry = { files: 0, hasDist: true, tally: {} };')]], run: 'leakFast', expect: 'generator CLI' },
  { id: 'LG13', what: 'the unkeyed-active-deal warning is removed', edits: [['scripts/leak-gate-hashes.mjs', sub('if (entries.length && !keyed) {', 'if (false) {')]], run: 'leakFast', expect: 'generator CLI' },
  { id: 'LG14', what: 'the short-term warning is removed', edits: [['scripts/leak-gate-hashes.mjs', sub('  if (short) {', '  if (false) {')]], run: 'leakFast', expect: 'generator CLI' },
  { id: 'LG15', what: 'the Netlify build command swallows a gate failure (|| true)', edits: [['netlify.toml', sub('node --test tests/site/leak-gate.test.mjs"', 'node --test tests/site/leak-gate.test.mjs || true"')]], run: 'leakFast', expect: 'Netlify build command' },
  { id: 'LG16', what: 'a [context.production] block overrides the build command without the gate', edits: [['netlify.toml', (t) => t + '\n[context.production]\n  command = "node scripts/build-kb.mjs && node scripts/build-dist.mjs"\n']], run: 'leakFast', expect: 'Netlify build command' },
  { id: 'LG17', what: 'a keyed file without the key is reported as fresh', edits: [['scripts/leak-gate-hashes.mjs', sub("return { state: 'needs-key', active: entries.length };", "return { state: 'fresh', active: entries.length };")]], run: 'leakFast', expect: 'roster staleness is detected' },
  { id: 'LG18', what: 'missing required scan targets are no longer reported', edits: [['scripts/lib/leak-gate.mjs', sub('return required.filter((f) => !files.includes(f) || !existsSync(path.join(root, f)));', 'return [];')]], run: 'leakFast', expect: 'scanFiles' },
  { id: 'LG19', what: 'a symlink or submodule entry is no longer a finding', edits: [['scripts/lib/leak-gate.mjs', sub('    if (!st.isFile()) {', '    if (false) {')]], run: 'leakFast', expect: 'symlinks are findings' },
  { id: 'LG20', what: 'the second look-alike pass (after lowercasing) is removed', edits: [['scripts/lib/leak-gate.mjs', dropLine(/^ {2}if \(\/\[\^\\u0000-\\u007f\]\/\.test\(t\)\) t = [^\n]*\n/m)]], run: 'leakFast', expect: 'second look-alike pass' },
  { id: 'LG21', what: 'escaped backslash-n is no longer treated as a separator', edits: [['scripts/lib/leak-gate.mjs', dropLine(/^ +\.replace\(\/\\\\\[nrt\]\/g[^\n]*\n/m)]], run: 'leakFast', expect: 'escaped newlines/tabs' },
  { id: 'LG22', what: 'NODE_OPTIONS in netlify.toml narrows the gate to one test', edits: [['netlify.toml', (t) => t.replace('[build.environment]', '[build.environment]\n  NODE_OPTIONS = "--test-name-pattern=^aliases"')]], run: 'leakFast', expect: 'Netlify build command' },
  { id: 'LG23', what: 'a dotted context key overrides the build command without the gate', edits: [['netlify.toml', (t) => t + '\ncontext.production.command = "node scripts/build-kb.mjs && node scripts/build-dist.mjs"\n']], run: 'leakFast', expect: 'Netlify build command' },
  { id: 'LG3', what: 'the PDF extractor goes blind (skips every content stream)', edits: [['scripts/lib/leak-gate-pdf.mjs', sub('if (!/\\bBT\\b/.test(d)) continue;', 'continue;')]], run: 'leakFast', expect: 'PDF text layers' },
];

// validate-jsonld.js run directly on synthetic pages: [id, what, html, wantExit0]
export const VALIDATOR_CASES = [
  ['V1', 'id-first tag, broken JSON', '<html><script type="application/ld+json">{"@type":"Thing"}</script><script id="x" type="application/ld+json">{BROKEN</script></html>', false],
  ['V2', 'single-quoted type, broken JSON', `<html><script type="application/ld+json">{"@type":"Thing"}</script><script type='application/ld+json' id=y>{BROKEN</script></html>`, false],
  ['V3', 'last JSON-LD tag never closed (count mismatch)', '<html><script type="application/ld+json">{"@type":"Thing"}</script><script type="application/ld+json">{"@type":"Other"}</html>', false],
  ['V4', 'ld+json5 block with broken JSON beside a valid block (not JSON-LD)', '<html><script type="application/ld+json">{"@type":"Thing"}</script><script type="application/ld+json5">{BROKEN</script></html>', true],
  ['V5', '"<!--" inside a JSON string, then a real comment', '<html><script type="application/ld+json">{"@type":"A","d":"<!--"}</script><p>x</p><script type="application/ld+json">{"@type":"B"}</script><!-- c --></html>', true],
  ['V6', '"<!-->" then a valid block', '<html><!--><script type="application/ld+json">{"@type":"A"}</script><!-- later --></html>', true],
  ['V7', 'unclosed "<!--" hides a broken block', '<html><script type="application/ld+json">{"@type":"A"}</script><!-- <script type="application/ld+json">{BROKEN</script></html>', true],
];
