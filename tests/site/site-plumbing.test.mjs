// Guards for the 2026-10-04 consistency + plumbing pass (ChatGPT "10/10" review
// adjudication). Each test pins one finding so it cannot quietly come back:
//   P1 legacy Squarespace/Wix URLs that returned 404 now 301 to a built page
//   P2 markets/index no longer says "three markets" (2 core + Kansas City holding)
//   P3 before/after sliders are not role="img" parents of an interactive slider
//   P4 scrollable regions are keyboard-focusable and named; no empty <th>
//   P5 breadcrumb links on the resources pages do not rely on colour alone
//   P6 /for-brokers carries a Submit a Deal button inside the hero (mobile fold)
//   P7 every property page is linked from outside /portfolio; Track Record links
//      its case studies to their property pages
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function redirectRules() {
  return read('_redirects')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));
}

const pageFileFor = (urlPath) =>
  urlPath === '/' ? 'index.html' : urlPath.endsWith('/') ? `${urlPath.slice(1)}index.html` : `${urlPath.slice(1)}.html`;

test('P1 legacy URLs 301 to a page that ships', () => {
  const rules = redirectRules();
  const catchAll = rules.findIndex(([from]) => from === '/*');
  const legacy = {
    '/about-us': '/about',
    '/gallery-3': '/portfolio',
    '/sell': '/sell-your-building',
    '/portfolio-1/4595-east-fifth-pbabg': '/properties/4595-e-fifth-avenue',
  };
  for (const [from, to] of Object.entries(legacy)) {
    const i = rules.findIndex(([f]) => f === from);
    assert.ok(i >= 0, `missing redirect for ${from}`);
    assert.ok(i < catchAll, `${from} must come before the /* catch-all`);
    assert.equal(rules[i][1], to, `${from} should redirect to ${to}`);
    assert.equal(rules[i][2], '301', `${from} must be a 301`);
    assert.ok(existsSync(path.join(ROOT, pageFileFor(to))), `${to} does not resolve to a source page`);
  }
});

test('P2 markets/index states two core markets plus a Kansas City holding', () => {
  const html = read('markets/index.html');
  assert.doesNotMatch(html, /three markets/i, 'markets/index must not say "three markets"');
  assert.match(html, /two core markets/i);
  assert.match(html, /Kansas City holding/i);
  assert.match(html, /href="\/properties\/9620-state-route-350"/, 'Kansas City card should link to its property page');
  // The same canonical wording (2 core + a Kansas City holding) holds wherever the firm's
  // market count is stated, including the chatbot prompt and the About timeline.
  for (const f of ['about.html', 'index.html', 'portfolio.html', 'netlify/edge-functions/chat.ts', 'llms.txt', 'scripts/overview-pdf/overview.html']) {
    const text = read(f);
    assert.doesNotMatch(text, /three core markets|three markets/i, `${f} must not say three markets`);
  }
  const chat = read('netlify/edge-functions/chat.ts');
  assert.match(chat, /two core markets, Maryland and Columbus OH, plus a Kansas City MO holding/);
  assert.match(chat, /two core markets, Maryland and Columbus, plus a Kansas City holding/, 'broker buy-box line must keep Kansas City');
  assert.match(read('about.html'), /513,000\+ SF, 138\+ tenants, two core markets, plus a Kansas City holding/);
  assert.doesNotMatch(read('llms.txt'), /single-building/i, 'a "single-building" holding is a building count');
});

test('P3 before/after slider containers are role=group, never role=img', () => {
  for (const file of ['index.html', 'track-record.html']) {
    const html = read(file);
    const containers = [...html.matchAll(/<div class="ba-slider"[^>]*>/g)].map((m) => m[0]);
    assert.ok(containers.length > 0, `${file}: expected a .ba-slider`);
    for (const c of containers) {
      assert.doesNotMatch(c, /role="img"/, `${file}: a role=img parent of the slider is nested-interactive`);
      assert.match(c, /role="group"/);
      assert.match(c, /aria-label="[^"]+"/);
    }
  }
});

test('P4 scrollable regions are focusable and named; the comparison table has no empty header cell', () => {
  const sell = read('sell-your-building.html');
  const wrap = sell.match(/<div class="owner-compare-wrap[^>]*>/)?.[0] ?? '';
  assert.match(wrap, /tabindex="0"/);
  assert.match(wrap, /role="region"/);
  assert.match(wrap, /aria-label="[^"]+"/);
  assert.doesNotMatch(sell, /<th>(?:&nbsp;|\s)*<\/th>/, 'empty <th> in the owner comparison table');
  const about = read('about.html');
  const track = about.match(/<div class="history-timeline__track"[^>]*>/)?.[0] ?? '';
  assert.match(track, /tabindex="0"/);
  assert.match(track, /role="region"/);
  assert.match(track, /aria-label="[^"]+"/);
});

test('P5 resources breadcrumb links are underlined (not colour-only)', () => {
  const dir = path.join(ROOT, 'resources');
  const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const html = read(`resources/${f}`);
    if (!html.includes('breadcrumb-nav')) continue;
    const rule = html.match(/\.breadcrumb-nav a\{[^}]*\}/)?.[0];
    assert.ok(rule, `resources/${f}: a breadcrumb-nav with no link style rule would silently pass`);
    assert.match(rule, /text-decoration:underline/, `resources/${f}: breadcrumb link relies on colour alone`);
  }
});

test('P6 /for-brokers hero has a Submit a Deal button that targets the intake form', () => {
  const html = read('for-brokers.html');
  const hero = html.match(/<div class="subpage-hero__content">[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(hero, /<a href="#broker-network" class="btn btn--gold">Submit a Deal<\/a>/);
  assert.match(html, /<section[^>]*id="broker-network"/, 'the #broker-network anchor must exist');
});

test('P7 every property page is linked from outside /portfolio; Track Record links its case studies', () => {
  const props = readdirSync(path.join(ROOT, 'properties')).filter((f) => f.endsWith('.html'));
  assert.ok(props.length >= 18);
  const pages = [];
  const walk = (dir) => {
    for (const f of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${f.name}` : f.name;
      if (f.isDirectory()) {
        if (['properties', 'markets', 'resources'].includes(f.name)) walk(rel);
      } else if (f.name.endsWith('.html')) pages.push(rel);
    }
  };
  walk('');
  for (const p of props) {
    const slug = p.replace(/\.html$/, '');
    const linkers = pages.filter(
      (f) => f !== `properties/${p}` && f !== 'portfolio.html' && read(f).includes(`href="/properties/${slug}"`),
    );
    assert.ok(linkers.length >= 1, `properties/${p} is linked only from /portfolio (near-orphan)`);
  }
  const tr = read('track-record.html');
  const linked = new Set([...tr.matchAll(/href="\/properties\/([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.ok(linked.size >= 6, `track-record should link its case studies to property pages, found ${linked.size}`);
});

// W4 — /what-we-see ("What We See That Other Buyers Don't"). Supported claims only: every
// figure and project fact on it already appears on the Track Record / property pages. The
// unsupported replacement-cost range and margin-of-safety figures (audit C-09), ownership
// structure, lender wording, occupancy and building counts must not creep in.
test('P9 /what-we-see is built from supported claims only and is linked from the pages that matter', () => {
  const html = read('what-we-see.html');
  // Only the page's own copy: nav, announcement bar and footer are shared chrome governed elsewhere.
  const main = html.match(/<main[\s\S]*<\/main>/)?.[0] ?? '';
  assert.ok(main.length > 2000, 'what-we-see.html has no <main> content');
  const text = main.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  for (const h of ['Basis matters', 'Function matters', 'Vacancy is priced, not feared', 'Complexity can create mispricing', 'We do not need aggressive rent growth', 'We own and operate']) {
    assert.ok(html.includes(h), `missing section: ${h}`);
  }
  const banned = [
    [/\$1[38]0|\b40\s*[–-]\s*65\s*%|margin of safety/i, 'unsupported replacement-cost / margin-of-safety figures (audit C-09)'],
    [/joint venture|partnership|co-invest/i, 'ownership structure'],
    [/lender|\bloan\b|mortgage|non-recourse|\bLTV\b/i, 'lender wording'],
    [/\d+\s*%\s*(occupied|occupancy|leased)|occupancy (of|at) \d/i, 'an occupancy figure'],
    [/\b\d+\s+(buildings|properties|assets)\b/i, 'a building / property count'],
    [/\bNOI\b|\bIRR\b|equity multiple|yield on cost|cash-on-cash/i, 'return metrics Track Record already governs'],
    [/permanent|30[- ]day|best-in-class|world-class|unparalleled/i, 'banned or unsupported wording'],
    [/no broker required|never failed to close/i, 'claims the audit struck'],
  ];
  for (const [re, why] of banned) assert.doesNotMatch(text, re, `what-we-see.html contains ${why}`);
  // Dollar figures: only the $36-$85 per-SF basis range already supported by Track Record.
  const dollars = [...text.matchAll(/\$\s?[\d,.]+\s?[MK]?/g)].map((m) => m[0].trim());
  assert.deepEqual(dollars.sort(), ['$36', '$85'].sort(), `unexpected dollar figures: ${JSON.stringify(dollars)}`);
  // Property facts it cites exist on the property / Track Record pages it links to.
  const tr = read('track-record.html').replace(/<[^>]+>/g, ' ');
  for (const fact of ['vapor mitigation', 'truck-height docks', 'one year remaining', '9,500 SF of office', 'purchased vacant', 'acquired largely vacant']) {
    assert.match(tr, new RegExp(fact), `Track Record no longer supports: ${fact}`);
  }
  for (const [file, label] of [['for-brokers.html', 'for-brokers'], ['index.html', 'home'], ['about.html', 'about']]) {
    assert.match(read(file), /href="\/what-we-see"/, `${label} must link to /what-we-see`);
  }
  assert.match(read('llms.txt'), /oxfordra\.net\/what-we-see/);
  assert.match(read('scripts/build-kb.mjs'), /what-we-see\.html/);
  assert.match(read('scripts/build-dist.mjs'), /'what-we-see\.html'/);
});

// W3 — case-study facts (Gabriel's rulings, 2026-10-04): 3540's ~12% is yield on total
// cost (price + renovation), not a going-in cap. Gabriel then put Fairground's 4.5x
// equity multiple and 63%+ IRR tiles BACK (and the "cap-rate expansion" meta wording),
// so those are pinned as published; the chatbot may quote them like any other
// Track Record figure.
test('P8 3540 ~12% is labeled yield on cost; Fairground keeps its published multiple and IRR', () => {
  const home = read('index.html');
  const tr = read('track-record.html');
  for (const [name, html] of [['index.html', home], ['track-record.html', tr]]) {
    assert.doesNotMatch(html, /going-in cap/i, `${name}: "going-in cap" mislabels a yield on cost`);
  }
  assert.match(home, /~12%<\/span><span class="metric-tile__label">Yield on Cost</);
  assert.match(tr, /~12%<\/span>\s*<span class="metric__label">Yield on Cost</);
  const fair = tr.slice(tr.indexOf('<h3>Fairground Village Center</h3>'));
  assert.match(fair, /4\.5×<\/span><span class="metric__label">Equity Multiple</, 'Fairground 4.5x equity multiple tile was restored at Gabriel\'s direction');
  assert.match(fair, /63%\+<\/span><span class="metric__label">IRR</, 'Fairground 63%+ IRR tile was restored at Gabriel\'s direction');
  // Meta says NOI growth, not "cap-rate expansion" (which reads as a value loss): Gabriel's wording.
  assert.match(tr, /proven NOI growth on generational holds/);
  assert.doesNotMatch(tr, /cap-rate expansion/i);
  assert.match(read('netlify/edge-functions/chat.ts'), /cap rate, yield on cost, IRR, and sale-price figures/);
  assert.match(read('scripts/meta.md'), /equity multiple, IRR, and sale-price figures/);
});

// ── 2026-10-05 follow-ups (Gabriel's decisions) ─────────────────────────────

test('P10 the Search Console ownership tag is on the home page head', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<meta name="google-site-verification" content="[A-Za-z0-9_-]{30,}">/);
  assert.equal((html.match(/google-site-verification/g) || []).length, 1, 'exactly one verification tag');
});

test('P11 the privacy policy describes the data flows the code actually has, and drops what it does not', () => {
  const text = read('privacy.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, '’');
  // Statements that were false or overstated.
  for (const [re, why] of [
    [/brokerage license information/i, 'there is no license field on the broker form'],
    [/tenant portal/i, 'there is no tenant portal'],
    [/_gid/, '_gid is a Universal Analytics cookie; GA4 sets _ga and _ga_<id>'],
    [/anonymized/i, 'GA4 uses a pseudonymous identifier once accepted'],
    [/umami/i, 'Umami is not loaded'],
    [/to prevent cross-site scripting/i, 'CSP helps protect, it does not prevent'],
  ]) assert.doesNotMatch(text, re, `privacy.html still says something untrue: ${why}`);
  // Data flows that must be disclosed.
  for (const needle of [
    'AI Chat Assistant', 'Anthropic', 'Microsoft 365', 'Netlify', 'reCAPTCHA', 'OpenStreetMap', 'unpkg.com',
    'credit report, driver’s license', 'credit and background checks you authorize', '_ga_YDSX0RW5HC',
    'Decline', '9510 Persimmon Tree Road, Suite 200', 'Potomac, MD 20854',
  ]) assert.ok(text.includes(needle), `privacy.html must disclose: ${needle}`);
  // No invented promises (retention periods, texting commitments, Do Not Track) without Gabriel's say-so.
  assert.doesNotMatch(text, /retain(ed)? for \d|\b\d+ (days|months|years)\b.*(retain|keep)/i, 'no invented retention period');
  assert.doesNotMatch(text, /do not track|reply stop/i, 'texting and Do Not Track commitments are counsel items, not added here');
});

test('P12 the Overview PDF source follows the rulings: gross only, two core markets plus a holding, no tenant tiles, no partnership footnote', () => {
  const html = read('scripts/overview-pdf/overview.html');
  assert.match(html, /Square footage and tenant counts are gross\.<\/p>/);
  assert.doesNotMatch(html, /50% partnership|held in 50%/i, 'ownership structure must not appear (Gabriel, 2026-10-02 and 2026-10-05)');
  assert.match(html, /<h2>Two Core Markets, Plus a Kansas City Holding<\/h2>/);
  assert.match(html, /Holding, entered 2024/);
  const markets = html.slice(html.indexOf('<div class="markets">'), html.indexOf('<p class="expansion">'));
  assert.doesNotMatch(markets, /class="l">Tenants</, 'per-market tenant tiles summed to 129+ against a 138+ headline');
  assert.match(html, /class="mult">2\.6x<\/td>/, 'Sepich matches the site (~2.6x)');
  assert.match(html, /two core markets, Maryland and Columbus OH, plus a Kansas City MO holding/);
});

test('P13 the owner form text-consent box is optional and states the consent terms', () => {
  const html = read('sell-your-building.html');
  const box = html.match(/<input type="checkbox" id="owner-consent"[^>]*>/)?.[0] ?? '';
  assert.ok(box, 'consent checkbox missing');
  assert.doesNotMatch(box, /\brequired\b/, 'consent cannot be a condition of submitting');
  assert.match(box, /name="tcpa-consent"/, 'field name feeds owner-lead-notify');
  assert.match(html, /Consent is not required to submit\. Msg &amp; data rates may apply\. Reply STOP to opt out\./);
});
