// Main-thread guards from the 2026-09-24 PageSpeed desktop audit (Performance 89,
// TBT 250 ms the only non-green metric).
//
// Each test pins one finding so it cannot quietly come back:
//   #1  gtag.js (177 KiB) parsed and ran on the main thread: two long tasks
//       (193 + 167 ms). The old "defer to interaction or 3s" loader did not help
//       the lab score, because Lighthouse's simulator collapses timer delays and
//       still placed gtag inside the load window. GA4 now runs in a Partytown
//       web worker.
//   #2  Forced reflow: script.js read hero.offsetHeight at DOMContentLoaded
//       (in a requestIdleCallback that can fire before the first paint). Nothing
//       read the value: the nav "scrolled" threshold receives it by value before
//       the measure runs.
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const GA_ID = 'G-YDSX0RW5HC';
const SKIP_DIRS = new Set(['dist', 'node_modules', 'scripts', 'tests', 'evals', 'docs', 'netlify', 'data']);

function htmlFiles(dir = ROOT, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || (!rel && SKIP_DIRS.has(name))) continue;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...htmlFiles(abs, r));
    else if (name.endsWith('.html')) out.push(r);
  }
  return out;
}

// Parse every <script ...>body</script> into { attrs, body, index }.
function scripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-z-]+)(?:=("([^"]*)"|'([^']*)'|[^\s>]+))?/gi)) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[2] ?? '';
    }
    return { attrs, body: m[2], index: m.index };
  });
}

// Every published page except the internal Netlify Forms shells (*-form.html)
// must carry GA; deriving the list from ID matches would let a page silently
// lose its loader.
const GA_PAGES = htmlFiles().filter((f) => !/-form\.html$/.test(f));
const PT_SNIPPET = 'assets/partytown/partytown.js';
const PT_BANNER = existsSync(path.join(ROOT, PT_SNIPPET)) ? read(PT_SNIPPET).match(/Partytown (\d+\.\d+\.\d+)/)?.[1] : undefined;

test('GA4 is installed on every public page (sanity: the page list is not empty)', () => {
  assert.ok(GA_PAGES.length >= 20, `only ${GA_PAGES.length} pages carry ${GA_ID}`);
});

test('#1 gtag.js never loads on the main thread: it runs only as a text/partytown script', () => {
  const bad = [];
  for (const f of GA_PAGES) {
    const html = read(f);
    const s = scripts(html);
    const gtagSrc = s.filter((x) => /googletagmanager\.com\/gtag\/js/.test(x.attrs.src || ''));
    if (gtagSrc.length !== 1) bad.push(`${f}: ${gtagSrc.length} gtag.js <script src> tags (want exactly 1)`);
    else if (gtagSrc[0].attrs.type !== 'text/partytown') bad.push(`${f}: gtag.js <script src> is type="${gtagSrc[0].attrs.type || ''}", not text/partytown`);
    // The old loader built the tag in JS; any script that injects gtag.js by hand is a regression.
    for (const x of s) {
      if (x.attrs.type !== 'text/partytown' && /googletagmanager|gtag\/js/.test(x.body)) bad.push(`${f}: a main-thread script references googletagmanager/gtag.js (hand-built loader?)`);
    }
    // page_view comes solely from gtag('config'); exactly one, inside the worker.
    const cfg = s.filter((x) => x.body.includes(`gtag('config','${GA_ID}')`));
    if (cfg.length !== 1 || cfg[0].attrs.type !== 'text/partytown') bad.push(`${f}: want exactly one gtag('config') and it must be text/partytown (found ${cfg.length})`);
  }
  assert.deepEqual(bad, []);
});

test('#1 Partytown is configured before its snippet loads, forwards gtag + dataLayer.push, and matches the vendored version', () => {
  assert.ok(PT_BANNER, 'assets/partytown/partytown.js has no "Partytown x.y.z" banner');
  const bad = [];
  for (const f of GA_PAGES) {
    const s = scripts(read(f));
    const cfg = s.find((x) => /\bpartytown\s*=\s*\{/.test(x.body));
    const snip = s.find((x) => /^\/assets\/partytown\/partytown\.js\?v=/.test(x.attrs.src || ''));
    if (!cfg) { bad.push(`${f}: no partytown={...} config`); continue; }
    if (!snip) { bad.push(`${f}: no /assets/partytown/partytown.js snippet`); continue; }
    if (cfg.index > snip.index) bad.push(`${f}: partytown config comes after the snippet`);
    if (!/lib:'\/assets\/partytown\/'/.test(cfg.body)) bad.push(`${f}: partytown lib is not '/assets/partytown/'`);
    if (!/forward:\[[^\]]*'dataLayer\.push'[^\]]*'gtag'/.test(cfg.body)) bad.push(`${f}: partytown does not forward dataLayer.push and gtag`);
    const v = snip.attrs.src.split('?v=')[1];
    if (v !== PT_BANNER) bad.push(`${f}: snippet ?v=${v} but vendored Partytown is ${PT_BANNER}`);
  }
  assert.deepEqual(bad, []);
});

test('#1 the Partytown runtime ships: lib files are under a published dir, and the CSP allows its same-origin sandbox iframe', () => {
  for (const f of ['partytown.js', 'partytown-sw.js', 'partytown-media.js', 'LICENSE']) {
    assert.ok(existsSync(path.join(ROOT, 'assets/partytown', f)), `assets/partytown/${f} is missing`);
  }
  assert.ok(PT_BANNER, `${PT_SNIPPET} has no "Partytown x.y.z" banner`);
  const sw = read('assets/partytown/partytown-sw.js');
  assert.match(sw, new RegExp(`Partytown ${PT_BANNER.replace(/\./g, '\\.')}\\b`), 'partytown-sw.js is a different version than partytown.js');
  const csp = read('_headers').match(/Content-Security-Policy:([^\n]*)/)[1];
  const frameSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'));
  assert.ok(frameSrc && frameSrc.split(/\s+/).includes("'self'"), `CSP frame-src must include 'self' for the Partytown sandbox iframe (got: ${frameSrc})`);
  assert.ok(frameSrc.includes('https://www.google.com/recaptcha/'), 'CSP frame-src lost the reCAPTCHA origin');
});

test('#2 script.js takes no dead geometry read at DOMContentLoaded (forced reflow)', () => {
  const js = read('script.js');
  assert.ok(!/\bhero\.offsetHeight\b/.test(js), 'script.js reads hero offsetHeight again; nothing consumes it and it forces a layout');
  // The only requestIdleCallback call is the one inside runWhenIdle(), which waits for
  // the load event first; any other one can fire before first paint.
  assert.equal((js.match(/\brequestIdleCallback\(/g) || []).length, 1, 'script.js schedules work with a bare requestIdleCallback that can fire before first paint; use runWhenIdle()');
  assert.match(js, /runWhenIdle\(measureSections\)/, 'the scrollspy measure must go through runWhenIdle()');
});

// ── 2026-09-28 conversion-event pass (Phase 2 of the fix plan) ──────────────
// GA4 previously saw only page_view; the three lead-generating success paths
// now fire a named event so Gabriel can see which pages/channels actually
// produce a broker submission, a tenant application, or a contact message.

test('WP-17 the broker deal-submission success path fires a broker_deal_submitted GA4 event', () => {
  const html = read('for-brokers.html');
  const successBlock = html.match(/window\.ORA_BROKER_UPLOAD\.submit\(form\)\.then\(function\(result\)\{[\s\S]*?\}\)\.catch/)?.[0] ?? '';
  assert.match(successBlock, /gtag\('event',\s*'broker_deal_submitted'/, 'for-brokers.html success handler does not fire broker_deal_submitted');
  // Must come after the success message is revealed, never inside .catch (a failed upload is not a submission).
  assert.ok(successBlock.indexOf("success.style.display = ''") < successBlock.indexOf('broker_deal_submitted'), 'broker_deal_submitted fires before the success state is shown');
});

test('WP-18 application-received.html fires tenant_application_submitted exactly once, inside the text/partytown gtag worker', () => {
  const html = read('application-received.html');
  const s = scripts(html).filter((x) => x.body.includes("gtag('event','tenant_application_submitted')"));
  assert.equal(s.length, 1, 'application-received.html must fire tenant_application_submitted exactly once');
  assert.equal(s[0].attrs.type, 'text/partytown', 'the event call must live in the same text/partytown worker script as gtag(\'config\',...), not a main-thread script racing Partytown\'s proxy setup');
});

test('WP-19 contact.html has a wired AJAX success handler (was dead markup — #contactSuccess had no JS reveal) and fires contact_form_submit', () => {
  const html = read('contact.html');
  assert.match(html, /document\.getElementById\('contactError'\)/, 'contact.html has no error box wired — the success handler this test expects is missing');
  const successBlock = html.match(/document\.addEventListener\('submit',\s*function\(e\)\{\s*if\(e\.target !== form \|\| e\.defaultPrevented\) return;[\s\S]*?\}\)\.catch/)?.[0] ?? '';
  assert.match(successBlock, /success\.style\.display = '';/, 'contact.html submit handler does not reveal #contactSuccess');
  assert.match(successBlock, /success\.scrollIntoView/, 'contact.html submit handler does not scroll the success message into view');
  assert.match(successBlock, /gtag\('event',\s*'contact_form_submit'/, 'contact.html success handler does not fire contact_form_submit');
  assert.ok(successBlock.indexOf("success.style.display = ''") < successBlock.indexOf('contact_form_submit'), 'contact_form_submit fires before the success state is shown');
});

// ── 2026-10-04 Consent Mode v2 (ChatGPT "10/10" review adjudication) ────────
// Before: GA4 loaded and configured on every page with NO consent default, and
// the cookie banner's Accept/Decline only wrote a localStorage flag, so Decline
// did nothing to analytics. Now analytics_storage is denied in the SAME inline
// text/partytown script that configures GA4, ahead of gtag('config'). It must be
// inline: Partytown's 10s main-thread fallback re-inserts external text/partytown
// scripts asynchronously but runs inline ones immediately, so a separate
// consent script lets 'config' win the race (found by the independent review).
// Accept grants analytics only, Decline never does.

test('C1 on every GA page the Consent Mode default sits in the same inline text/partytown script as gtag("config"), before it', () => {
  const bad = [];
  for (const f of GA_PAGES) {
    const s = scripts(read(f));
    const cfg = s.filter((x) => x.body.includes(`gtag('config','${GA_ID}')`));
    if (cfg.length !== 1) { bad.push(`${f}: want exactly one script with gtag('config') (found ${cfg.length})`); continue; }
    const { attrs, body } = cfg[0];
    if (attrs.type !== 'text/partytown' || attrs.src) bad.push(`${f}: the config script must be inline text/partytown`);
    const iDefault = body.indexOf("gtag('consent','default'");
    if (iDefault < 0) bad.push(`${f}: no gtag('consent','default') in the config script`);
    else if (iDefault > body.indexOf(`gtag('config','${GA_ID}')`)) bad.push(`${f}: consent default must come BEFORE gtag('config')`);
    if (s.some((x) => /consent-default\.js/.test(x.attrs.src || ''))) bad.push(`${f}: a separate async consent script races config in Partytown's fallback mode`);
  }
  assert.deepEqual(bad, []);
  assert.ok(!existsSync(path.join(ROOT, 'assets/consent-default.js')), 'assets/consent-default.js is obsolete');
});

test('C2 the inline default denies all four Consent Mode v2 signals; only a stored Accept can start granted; window.gtag is assigned', () => {
  const bodies = new Set(GA_PAGES.map((f) => scripts(read(f)).find((x) => x.body.includes(`gtag('config','${GA_ID}')`)).body.replace(/gtag\('event','tenant_application_submitted'\);?\s*/, '')));
  assert.equal(bodies.size, 1, `the inline GA script should be byte-identical on every page (apart from the tenant event), found ${bodies.size} variants`);
  const js = [...bodies][0];
  for (const k of ['ad_storage', 'ad_user_data', 'ad_personalization']) {
    assert.match(js, new RegExp(`${k}:'denied'`), `${k} must stay denied`);
  }
  assert.match(js, /analytics_storage:oraConsentGranted\?'granted':'denied'/);
  assert.match(js, /localStorage\.getItem\('oxford-cookies-accepted'\)==='true'/);
  assert.doesNotMatch(js, /oxford-cookies-declined/, 'a stored Decline must never be read as consent');
  // Partytown forwards main-thread window.gtag(...) to the worker's global gtag. A bare
  // `function gtag(){}` is private to its worker script, so the forwarded call throws.
  assert.match(js, /window\.gtag=function/, 'the inline script must assign window.gtag so forwarded calls resolve');
  assert.doesNotMatch(js, /function gtag\(\)/, 'a bare function declaration is private to the Partytown worker script');
});

test('C3 the cookie banner grants analytics only on Accept; Decline never grants', () => {
  const js = read('script.js');
  const grant = js.match(/grantAnalyticsConsent = function \(\) \{[\s\S]*?\n {8}\};/)?.[0] ?? '';
  assert.match(grant, /window\.gtag\("consent", "update", \{ analytics_storage: "granted" \}\)/);
  assert.doesNotMatch(grant, /ad_storage|ad_user_data|ad_personalization/, 'only analytics_storage may ever be granted');
  const accept = js.match(/acceptButton\.addEventListener\("click", function \(\) \{[\s\S]*?\}\);/)?.[0] ?? '';
  assert.match(accept, /grantAnalyticsConsent\(\)/, 'Accept must grant analytics consent');
  const decline = js.match(/declineButton\.addEventListener\("click", function \(\) \{[\s\S]*?\}\);/)?.[0] ?? '';
  assert.doesNotMatch(decline, /grantAnalyticsConsent|consent/, 'Decline must not grant anything');
});

test('C4 every GA page carries a cookie banner that names analytics cookies, so a visitor on any landing page can choose', () => {
  const bad = [];
  for (const f of GA_PAGES) {
    const html = read(f);
    for (const id of ['cookieBanner', 'cookieAccept', 'cookieDecline']) {
      if (!html.includes(`id="${id}"`)) bad.push(`${f}: missing #${id}`);
    }
    if (!/Decline keeps measurement cookieless/.test(html)) bad.push(`${f}: banner copy does not explain the analytics choice`);
  }
  assert.deepEqual(bad, []);
});

// ── 2026-10-04 click events + "how did you hear about us" ───────────────────

test('E1 script.js has one delegated click listener for phone, email, PDF and primary CTA events, all guarded by window.gtag', () => {
  const js = read('script.js');
  for (const name of ['phone_click', 'email_click', 'pdf_download', 'cta_click']) {
    assert.match(js, new RegExp(`send\\("${name}"`), `script.js does not send ${name}`);
  }
  assert.match(js, /if \(window\.gtag\) \{\s*window\.gtag\("event", name, params\);/, 'events must be guarded by window.gtag');
  for (const [p, cta] of [['/for-brokers', 'submit_deal'], ['/sell-your-building', 'get_offer'], ['/tenant-application', 'apply_now'], ['/contact', 'contact']]) {
    assert.ok(js.includes(`"${p}": "${cta}"`), `CTA path map is missing ${p} -> ${cta}`);
  }
  assert.equal((js.match(/document\.addEventListener\("click", function \(e\) \{\s*var link =/g) || []).length, 1, 'exactly one delegated click-tracking listener');
});

test('E2 the owner form fires owner_form_submit after its success state, carrying referral_source', () => {
  const html = read('sell-your-building.html');
  const block = html.match(/\.then\(function\(res\)\{[\s\S]*?\}\)\.catch/)?.[0] ?? '';
  assert.match(block, /gtag\('event',\s*'owner_form_submit'/);
  assert.match(block, /referral_source:/);
  assert.ok(block.indexOf("success.style.display = ''") < block.indexOf('owner_form_submit'), 'owner_form_submit fires before the success state is shown');
});

test('E3 contact, owner and broker forms ask an optional "How did you hear about us?" named referral-source, and it is carried through', () => {
  for (const f of ['contact.html', 'sell-your-building.html', 'for-brokers.html']) {
    const html = read(f);
    const sel = html.match(/<select id="[a-z-]+" name="referral-source">[\s\S]*?<\/select>/)?.[0] ?? '';
    assert.ok(sel, `${f}: no referral-source <select>`);
    assert.match(sel, /<option value="">Select\.\.\.<\/option>/, `${f}: the question must stay optional (blank default)`);
    assert.match(sel, /AI assistant/, `${f}: include an AI-assistant source so answer-engine referrals are measurable`);
    assert.doesNotMatch(sel.match(/<select[^>]*>/)[0], /\brequired\b/, `${f}: must not be required`);
  }
  assert.match(read('broker-intake-form.html'), /name="referral-source"/, 'the broker intake stub form must declare the field or Netlify drops it');
  assert.match(read('broker-upload.js'), /referralSource: \(formEl\.querySelector\('\[name="referral-source"\]'\) \|\| \{\}\)\.value \|\| ''/);
  assert.match(read('broker-upload.js'), /referralSource: fields\.referralSource/);
  assert.match(read('netlify/functions/broker-upload-session.js'), /'referral-source': referralSource \|\| ''/);
  assert.match(read('netlify/functions/broker-upload-session.js'), /referralSource: sanitizeField\(body\.referralSource, 60\)/);
  for (const f of ['contact-notify.js', 'owner-lead-notify.js']) {
    assert.match(read(`netlify/functions/${f}`), /'referral-source': 'How They Heard About Us'/, `${f}: unlabeled field would show raw in the email`);
  }
});

test('E4 email_click is labeled by firm mailbox name only (GA4 redacts email-shaped labels); other addresses are "external"', () => {
  const js = read('script.js');
  assert.match(js, /firmMailbox = \/\^\(\[a-z0-9\._-\]\+\)@oxfordra\\\.net\$\/i\.exec\(address\)/, 'the label must be the local part of a @oxfordra.net address');
  assert.match(js, /event_label: firmMailbox \? firmMailbox\[1\]\.toLowerCase\(\) : "external"/);
  assert.doesNotMatch(js, /event_label: \/@oxfordra/, 'a full address as the label is auto-redacted to "(redacted)" by GA4');
});

test('C5 the privacy policy describes the real analytics (GA4 with a consent choice) and no longer names Umami, which is not loaded', () => {
  for (const f of GA_PAGES) assert.doesNotMatch(read(f), /umami/i, `${f} mentions Umami, which this site does not load`);
  const p = read('privacy.html');
  assert.match(p, /only after you click Accept on our cookie notice/);
  assert.match(p, /if you click Decline/i);
});
