// Guards Netlify Forms registration on every page form.
//
// Netlify only (re)registers a form's field schema when its build-time parser
// finds `data-netlify="true"` (or a bare `netlify` attribute) on the <form>.
// The tenant-resources leasing-inquiry form was imported in the repo's
// "Initial commit via Netlify" from Netlify's post-processed HTML, which strips
// that attribute. Submissions kept landing against a stale schema registered on
// 2026-03-27, so company, SF needed, space type, timeline and details were
// silently dropped (reproduced 2026-09-23, submission 6ab431e57a61bc249185b3c2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { stripHtmlComments } = createRequire(import.meta.url)('../../scripts/validate-jsonld.js');

// Hidden detection stubs that are intentionally not wired. available-space's
// listing-inquiry stub is dead: every Inquire button on that page is a mailto:.
const EXEMPT = new Set(['available-space.html#listing-inquiry']);

// Every HTML file that can ship, at any depth. Netlify's form detection parses
// the whole publish directory, and build-dist.mjs copies assets/ (and the other
// site dirs) wholesale, so a form in assets/quote.html registers too.
const PRIVATE_DIRS = new Set(['dist', 'node_modules', '.netlify', '.git', 'tests', 'evals', 'scripts', 'netlify', 'docs', '.claude', 'data']);
function htmlFiles(rel = '') {
  const files = [];
  for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!PRIVATE_DIRS.has(e.name)) files.push(...htmlFiles(r)); }
    else if (e.name.endsWith('.html')) files.push(r);
  }
  return files;
}

// Parse attributes into a map; never assume attribute order or quote style.
function attrs(tag) {
  const map = {};
  for (const m of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    map[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return map;
}

// A commented-out form is neither registered by Netlify nor shown to anyone.
function forms(html) {
  html = stripHtmlComments(html);
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => ({
    attrs: attrs(m[1]),
    body: m[2],
  }));
}

function formName(form) {
  const hidden = [...form.body.matchAll(/<input\b([^>]*)>/gi)]
    .map((m) => attrs(m[1]))
    .find((a) => a.name === 'form-name');
  return hidden ? hidden.value : null;
}

// Every Netlify form the site registers, pinned. The test below skips a form
// with no hidden form-name input, so deleting both data-netlify and form-name
// from a page used to pass: the form simply vanished from the check. Adding or
// retiring a form means editing this list on purpose.
const EXPECTED_NETLIFY_FORMS = [
  'broker-intake-form.html#broker-submission-intake',
  'broker-ledger-form.html#broker-network-ledger',
  'chat-lead-form.html#chat-lead',
  'contact.html#contact',
  'pipeline-failures-form.html#pipeline-failures',
  'resources/industrial-building-sale-document-checklist.html#checklist-download',
  'sell-your-building.html#owner-submission-intake',
  'tenant-application.html#commercial-lease-application',
  'tenant-resources.html#leasing-inquiry',
];

test('the registered Netlify forms are exactly the pinned set, each posting a matching form-name', () => {
  const found = [];
  for (const file of htmlFiles()) {
    for (const form of forms(readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (!(form.attrs['data-netlify'] === 'true' || 'netlify' in form.attrs)) continue;
      const name = form.attrs.name ?? formName(form);
      found.push(`${file}#${name}`);
      assert.equal(formName(form), name, `${file}#${name}: hidden form-name input must equal the form name`);
    }
  }
  assert.deepEqual(found.sort(), [...EXPECTED_NETLIFY_FORMS].sort(), 'Netlify-registered forms drifted from the pinned set');
});

test('every form that posts a form-name is registered with Netlify Forms', () => {
  const unregistered = [];
  for (const file of htmlFiles()) {
    for (const form of forms(readFileSync(path.join(ROOT, file), 'utf8'))) {
      const name = formName(form);
      if (!name || EXEMPT.has(`${file}#${name}`)) continue;
      const registered = form.attrs['data-netlify'] === 'true' || 'netlify' in form.attrs;
      if (!registered) unregistered.push(`${file}#${name}`);
    }
  }
  assert.deepEqual(unregistered, [], 'forms missing data-netlify="true" (Netlify will not refresh their field schema)');
});

test('tenant-resources leasing-inquiry form has a honeypot and a wired success state', () => {
  const html = readFileSync(path.join(ROOT, 'tenant-resources.html'), 'utf8');
  const form = forms(html).find((f) => formName(f) === 'leasing-inquiry');
  assert.ok(form, 'leasing-inquiry form not found');
  assert.equal(form.attrs['netlify-honeypot'], 'bot-field');
  assert.match(form.body, /<input\b[^>]*name="bot-field"/, 'honeypot input missing');
  assert.equal(form.attrs.id, 'leasingForm', 'form needs id="leasingForm" for the submit handler');
  assert.match(form.body, /id="leasingSuccess"/, 'success message element missing');
  assert.match(html, /getElementById\('leasingSuccess'\)/, 'no script reveals #leasingSuccess');
});

test('the leasing-inquiry submit handler binds to the form: right id, runs after the form is parsed', () => {
  const html = stripHtmlComments(readFileSync(path.join(ROOT, 'tenant-resources.html'), 'utf8'));
  const formMatch = [...html.matchAll(/<form\b([^>]*)>[\s\S]*?<\/form>/gi)].find((m) => attrs(m[1]).name === 'leasing-inquiry');
  assert.ok(formMatch, 'leasing-inquiry form not found');
  const formId = attrs(formMatch[1]).id;
  const formEnd = formMatch.index + formMatch[0].length;

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  // JS comments are not code: a lookup or a DOMContentLoaded that only appears
  // in a comment does nothing. String literals are matched first and kept, so
  // '//' or '/*' inside a string ('image/*', a URL) is left alone.
  const code = (js) => js.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '');
  const handler = scripts.find((m) => /getElementById\(\s*['"]leasingSuccess['"]\s*\)/.test(code(m[2])));
  assert.ok(handler, 'no inline script reveals #leasingSuccess');
  const body = code(handler[2]);
  assert.match(body, new RegExp(String.raw`getElementById\(\s*['"]${formId}['"]\s*\)`), `handler never looks up the form by its id "${formId}"`);

  // An inline script runs where it is parsed; above </form> the getElementById
  // returns null and the `if(!form) return` guard makes the handler a silent no-op.
  const a = attrs(handler[1]);
  const deferred = (a.src && ('defer' in a || a.type === 'module')) || /addEventListener\(\s*['"]DOMContentLoaded['"]/.test(body);
  assert.ok(handler.index >= formEnd || deferred, 'handler script runs before the leasing form exists (move it below </form> or defer it)');

  // Every element the handler touches must exist, or the submit path throws mid-flight.
  const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  for (const [, id] of body.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(ids.has(id), `handler looks up #${id}, which is not on the page`);
  }
});

// Forms whose script reveals an in-form .form-success. The handler tests below
// cover every form they discover; this list pins the ones that must stay
// discovered, so renaming the class or the lookup can't drop a page silently.
const SUCCESS_FORMS = ['for-brokers.html#brokerForm', 'sell-your-building.html#ownerForm', 'tenant-resources.html#leasingForm'];

const lookup = (id) => `(?:getElementById\\(\\s*['"]${id}['"]\\s*\\)|querySelector\\(\\s*['"]#${id}['"]\\s*\\))`;
const bound = (js, id) => js.match(new RegExp(`(\\w+)\\s*=\\s*document\\.${lookup(id)}`))?.[1];

// Tag nesting depth at `index` within a form body; 0 means a direct child.
function depthAt(body, index) {
  let depth = 0;
  for (const m of body.slice(0, index).matchAll(/<(\/?)(?:div|p|section|fieldset|span|label|ul|ol|li|article|header|footer)\b[^>]*>/gi)) {
    depth += m[1] ? -1 : 1;
  }
  return depth;
}

// Every inline script that reveals a form's in-form success message, with
// comments stripped and the form/success variables bound from their lookups.
// `scripts` is every inline script on the page, since any of them could hide the form.
function successHandlers() {
  const handlers = [];
  for (const file of htmlFiles()) {
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'));
    for (const form of forms(html)) {
      const successTag = form.body.match(/<div\b[^>]*\bclass=["'][^"']*\bform-success\b[^>]*>/);
      const successId = successTag && attrs(successTag[0].slice(4, -1)).id;
      if (!form.attrs.id || !successId) continue;
      for (const js of scripts.filter((s) => new RegExp(lookup(successId)).test(s))) {
        handlers.push({
          file, form, formId: form.attrs.id, successId, js, scripts,
          depth: depthAt(form.body, successTag.index),
          formVar: bound(js, form.attrs.id), successVar: bound(js, successId),
        });
      }
    }
  }
  return handlers;
}

test('the success-handler tests still discover every known in-form success message', () => {
  const found = new Set(successHandlers().map((h) => `${h.file}#${h.formId}`));
  assert.deepEqual(SUCCESS_FORMS.filter((f) => !found.has(f)), [],
    'keep class="form-success" on the message and look it up with getElementById, or update SUCCESS_FORMS');
});

// A success message nested inside its <form> inherits the form's display, so a
// handler that hides the whole form on success hides the thank-you with it. The
// sell-your-building owner form shipped that way: the form vanished on a good
// submission and the owner saw no confirmation. The message must also be a
// direct child, or hiding the children hides its wrapper.
test('no script hides a form whose success message lives inside it', () => {
  const offenders = [];
  const hide = `\\s*\\.\\s*(?:style\\.display\\s*=\\s*['"]none['"]|style\\.setProperty\\(\\s*['"]display['"]\\s*,\\s*['"]none['"]|hidden\\s*=\\s*true|classList\\.(?:add|toggle)\\(\\s*['"]hidden['"]|setAttribute\\(\\s*['"]hidden['"]|remove\\(\\s*\\))`;
  for (const h of successHandlers()) {
    const hidesForm = h.scripts.some((js) => {
      const formVar = bound(js, h.formId);
      return new RegExp(`${lookup(h.formId)}${hide}`).test(js) || (formVar && new RegExp(`\\b${formVar}${hide}`).test(js));
    });
    const F = h.formVar, S = h.successVar;
    const reveal = S ? h.js.search(new RegExp(`\\b${S}\\.style\\.display\\s*=`)) : -1;
    const loop = F && S ? h.js.search(new RegExp(
      `(?:forEach\\.call\\(\\s*${F}\\.children\\b|Array\\.from\\(\\s*${F}\\.children\\s*\\)|\\[\\s*\\.\\.\\.\\s*${F}\\.children\\s*\\]|\\bof\\s+${F}\\.children\\b)` +
      `[\\s\\S]*?(?:!==?\\s*${S}\\b|\\b${S}\\s*!==?)`)) : -1;
    if (hidesForm || h.depth !== 0 || loop < 0 || loop > reveal) offenders.push(`${h.file}#${h.formId}`);
  }
  assert.deepEqual(offenders, [], 'hide form.children except the success element (a direct child), then reveal it; never hide the form');
});

// Collapsing a tall form to its success message leaves the message where the
// form's top was, usually above the viewport once the visitor has scrolled to
// the submit button. Scrolling before the reveal is a no-op, so order matters.
test('every script that reveals an in-form success message scrolls it into view', () => {
  const offenders = [];
  for (const h of successHandlers()) {
    const S = h.successVar;
    const reveal = S ? h.js.search(new RegExp(
      `\\b${S}\\.style\\.display\\s*=\\s*(?:''|""|'block'|"block")|\\b${S}\\.style\\.removeProperty\\(\\s*['"]display['"]|\\b${S}\\.hidden\\s*=\\s*false`)) : -1;
    const scroll = S ? h.js.search(new RegExp(`(?:\\b${S}|${lookup(h.successId)})\\s*\\.scrollIntoView\\(`)) : -1;
    if (reveal < 0 || scroll < reveal) offenders.push(`${h.file}#${h.successId}`);
  }
  assert.deepEqual(offenders, [], 'call success.scrollIntoView({ block: \'center\' }) after revealing it');
});

// script.js attaches a validator to form[data-netlify="true"] that sets
// novalidate and calls preventDefault() on invalid input. A handler registered
// on the form itself (or as a capture listener) runs before it and posts invalid
// data; a bubbling one on document runs after it and can check defaultPrevented,
// and must check e.target so it never acts on another form's submit. (Netlify
// strips data-netlify from served HTML today, but the order must not depend on that.)
test('success handlers on script.js-validated forms run after the validator', () => {
  const offenders = [];
  for (const h of successHandlers()) {
    if (h.form.attrs['data-netlify'] !== 'true') continue;
    const F = h.formVar;
    const bubbling = /\b(?:document|window)\.addEventListener\(\s*['"]submit['"]/.test(h.js)
      && !/\}\s*,\s*(?:true|\{[^}]*\bcapture\s*:\s*true[^}]*\})\s*\)/.test(h.js);
    const guarded = /\.defaultPrevented\b/.test(h.js)
      && F && new RegExp(`\\.target\\s*[!=]==?\\s*${F}\\b|\\b${F}\\s*[!=]==?\\s*\\w+\\.target\\b`).test(h.js);
    const onForm = F && new RegExp(`\\b${F}\\.(?:addEventListener\\(\\s*['"]submit['"]|onsubmit\\s*=)`).test(h.js);
    if (!bubbling || !guarded || onForm) offenders.push(`${h.file}#${h.formId}`);
  }
  assert.deepEqual(offenders, [], 'listen (bubbling) on document; return early unless e.target is the form and !e.defaultPrevented');
});

test('sell-your-building owner form has a honeypot and a wired success state', () => {
  const html = readFileSync(path.join(ROOT, 'sell-your-building.html'), 'utf8');
  const form = forms(html).find((f) => formName(f) === 'owner-submission-intake');
  assert.ok(form, 'owner-submission-intake form not found');
  assert.equal(form.attrs['netlify-honeypot'], 'bot-field');
  assert.match(form.body, /<input\b[^>]*name="bot-field"/, 'honeypot input missing');
  assert.equal(form.attrs.id, 'ownerForm', 'form needs id="ownerForm" for the submit handler');
  assert.match(form.body, /id="ownerSuccess"/, 'success message element missing');
  assert.match(html, /getElementById\(\s*['"]ownerSuccess['"]\s*\)/, 'no script reveals #ownerSuccess');
});

// The contact form is the one public lead form that carried only a honeypot: no
// reCAPTCHA, unlike the lease application, so bot traffic went straight into a
// channel Gabriel and Eric are emailed from (2026-09-28 lead-reliability pass).
// Netlify's built-in reCAPTCHA needs BOTH the form attribute and the placeholder
// element it renders the widget into; either alone silently does nothing.
test('contact form is reCAPTCHA-gated: form attribute plus the widget placeholder', () => {
  const form = forms(readFileSync(path.join(ROOT, 'contact.html'), 'utf8')).find((f) => formName(f) === 'contact');
  assert.ok(form, 'contact form not found');
  assert.equal(form.attrs['data-netlify-recaptcha'], 'true', 'form needs data-netlify-recaptcha="true"');
  assert.match(form.body, /<div\b[^>]*data-netlify-recaptcha="true"[^>]*><\/div>/, 'widget placeholder <div data-netlify-recaptcha="true"> missing inside the form');
  assert.match(form.body, /<input\b[^>]*name="bot-field"/, 'the honeypot stays as a second layer');
});

// ---------------------------------------------------------------------------
// Function-side wiring: every form name a Netlify function posts must be a form
// the site actually registers, and every pipeline-failures post must carry
// exactly the fields its stub declares. Netlify silently DROPS undeclared
// fields and blanks missing ones, so a renamed form or a drifted field set
// loses data with no error anywhere. This is a characterization net: it passes
// on the current code and fails when a producer or the stub drifts.
// ---------------------------------------------------------------------------
function functionFiles(rel = 'netlify/functions') {
  const files = [];
  for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) files.push(...functionFiles(r));
    else if (/\.(?:js|mjs)$/.test(e.name)) files.push(r);
  }
  return files.sort();
}

// Top-level keys of the object literal starting at src[open] === '{'. Handles
// quoted and bare keys, ignores nested braces/parens/strings, flags spreads.
function objectKeys(src, open) {
  const keys = [];
  let depth = 0, seg = '', quote = null;
  const flush = () => {
    const s = seg.trim(); seg = '';
    if (!s) return;
    if (s.startsWith('...')) { keys.push(`<spread:${s}>`); return; }
    const m = s.match(/^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?::|$)/);
    keys.push(m ? (m[1] ?? m[2] ?? m[3]) : `<unparsed:${s.slice(0, 30)}>`);
  };
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { seg += c; if (c === '\\') seg += src[++i]; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; seg += c; continue; }
    if (c === '{' || c === '(' || c === '[') { if (depth++ > 0) seg += c; continue; }
    if (c === '}' || c === ')' || c === ']') { if (--depth === 0) { flush(); return keys; } seg += c; continue; }
    if (c === ',' && depth === 1) { flush(); continue; }
    seg += c;
  }
  throw new Error('unterminated object literal');
}

// `forwardToNetlifyForm(` / `forwardToNetlifyFormImpl(` calls whose 2nd argument
// is a string literal. [^,] and \s match newlines, so calls split across lines
// (checklist-notify, contact-notify, owner-lead-notify, tenant-application-processor)
// are found too; a single-line regex silently misses them.
const CALL_RE = /forwardToNetlifyForm(?:Impl)?\(\s*[^,]+,\s*(['"])([^'"]+)\1\s*,\s*(\{)/g;

function producers() {
  const out = {};
  for (const file of functionFiles()) {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    const calls = [...src.matchAll(CALL_RE)].map((m) => ({ name: m[2], keys: objectKeys(src, m.index + m[0].length - 1) }));
    const consts = [...src.matchAll(/\b(WATCHED_FORM|NETLIFY_FORM_NAME)\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[2]);
    if (calls.length || consts.length) out[file] = { calls, consts, src };
  }
  return out;
}

const REGISTERED_NAMES = new Set(EXPECTED_NETLIFY_FORMS.map((f) => f.split('#')[1]));

// Per-file floor over the 8 producer files: a call site the scan misses (say, a
// regex regression to single-line matching) fails here even when another file
// already supplies the same form name.
const PRODUCER_FLOOR = {
  'netlify/functions/_shared/broker-scoring-run.mjs': ['pipeline-failures', 'broker-network-ledger'],
  'netlify/functions/broker-finalize.mjs': ['pipeline-failures', 'broker-network-ledger'],
  'netlify/functions/broker-upload-session.js': ['pipeline-failures', 'broker-submission-intake'],
  'netlify/functions/chat-lead.js': ['chat-lead'],
  'netlify/functions/checklist-notify.js': ['checklist-download', 'pipeline-failures'],
  'netlify/functions/contact-notify.js': ['contact', 'pipeline-failures'],
  'netlify/functions/owner-lead-notify.js': ['owner-submission-intake', 'pipeline-failures'],
  'netlify/functions/tenant-application-processor.js': ['commercial-lease-application', 'pipeline-failures'],
};
const NAME_FLOOR = ['contact', 'owner-submission-intake', 'checklist-download', 'commercial-lease-application', 'chat-lead', 'pipeline-failures', 'broker-network-ledger', 'broker-submission-intake'];

test('every form name a Netlify function posts is a registered Netlify form', () => {
  const found = producers();
  const names = new Set();
  const unregistered = [];
  for (const [file, p] of Object.entries(found)) {
    for (const n of [...p.calls.map((c) => c.name), ...p.consts]) {
      names.add(n);
      if (!REGISTERED_NAMES.has(n)) unregistered.push(`${file}: "${n}"`);
    }
  }
  assert.deepEqual(unregistered, [], 'a function posts a form name the site does not register (the submission would be dropped)');
  for (const n of NAME_FLOOR) assert.ok(names.has(n), `scan found no producer of "${n}": the scan is blind or the producer was removed`);
  for (const [file, floor] of Object.entries(PRODUCER_FLOOR)) {
    const p = found[file];
    assert.ok(p, `producer file ${file} not found`);
    const have = new Set([...p.calls.map((c) => c.name), ...p.consts]);
    for (const n of floor) assert.ok(have.has(n), `${file} should yield "${n}" but the scan found only: ${[...have].join(', ') || 'nothing'}`);
  }
  // chat-lead.js posts without forwardToNetlifyForm: it must declare its form name
  // and send it as form-name.
  const chat = found['netlify/functions/chat-lead.js'];
  assert.deepEqual(chat.consts.filter((n) => n === 'chat-lead'), ['chat-lead'], "chat-lead.js must declare NETLIFY_FORM_NAME = 'chat-lead'");
  assert.match(chat.src, /params\.append\(\s*['"]form-name['"]\s*,\s*NETLIFY_FORM_NAME\s*\)/, 'chat-lead.js must append NETLIFY_FORM_NAME as form-name');
});

test('every pipeline-failures post writes exactly the fields the stub declares', () => {
  const stub = readFileSync(path.join(ROOT, 'pipeline-failures-form.html'), 'utf8');
  const form = forms(stub).find((f) => f.attrs.name === 'pipeline-failures');
  assert.ok(form, 'pipeline-failures stub form not found');
  // forwardToNetlifyForm appends form-name itself (_shared/netlify-forms.js), so no
  // call-site literal carries it; bot-field is a honeypot, not data.
  const declared = [...form.body.matchAll(/<(?:input|textarea|select)\b([^>]*)>/gi)]
    .map((m) => attrs(m[1]).name)
    .filter((n) => n && n !== 'form-name' && n !== 'bot-field')
    .sort();
  assert.deepEqual(declared, ['detail', 'error-code', 'occurred-at', 'source-function', 'submission-id'], 'the stub field set changed: update the producers and this pin together');

  const sites = [];
  for (const [file, p] of Object.entries(producers())) {
    for (const c of p.calls) if (c.name === 'pipeline-failures') sites.push({ file, keys: [...c.keys].sort() });
  }
  const perFile = Object.fromEntries(Object.keys(PRODUCER_FLOOR).filter((f) => PRODUCER_FLOOR[f].includes('pipeline-failures')).map((f) => [f, 1]));
  const counted = {};
  for (const s of sites) counted[s.file] = (counted[s.file] ?? 0) + 1;
  assert.deepEqual(counted, perFile, 'pipeline-failures call sites per file changed (a dropped or renamed site, or a new one, must update this pin on purpose)');
  assert.equal(sites.length, 7, 'expected 7 pipeline-failures call sites');
  const bad = sites.filter((s) => JSON.stringify(s.keys) !== JSON.stringify(declared)).map((s) => `${s.file}: ${s.keys.join(',')}`);
  assert.deepEqual(bad, [], `these call sites write fields that differ from the stub's declared set (${declared.join(', ')}); Netlify drops undeclared fields and blanks missing ones`);
});
