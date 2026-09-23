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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Hidden detection stubs that are intentionally not wired. available-space's
// listing-inquiry stub is dead: every Inquire button on that page is a mailto:.
const EXEMPT = new Set(['available-space.html#listing-inquiry']);

function htmlFiles() {
  const files = [];
  for (const dir of ['', 'markets', 'resources']) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.html')) files.push(dir ? `${dir}/${name}` : name);
    }
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

function forms(html) {
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
  const html = readFileSync(path.join(ROOT, 'tenant-resources.html'), 'utf8');
  const formMatch = [...html.matchAll(/<form\b([^>]*)>[\s\S]*?<\/form>/gi)].find((m) => attrs(m[1]).name === 'leasing-inquiry');
  assert.ok(formMatch, 'leasing-inquiry form not found');
  const formId = attrs(formMatch[1]).id;
  const formEnd = formMatch.index + formMatch[0].length;

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const handler = scripts.find((m) => /getElementById\(\s*['"]leasingSuccess['"]\s*\)/.test(m[2]));
  assert.ok(handler, 'no inline script reveals #leasingSuccess');
  const body = handler[2];
  assert.match(body, new RegExp(String.raw`getElementById\(\s*['"]${formId}['"]\s*\)`), `handler never looks up the form by its id "${formId}"`);

  // An inline script runs where it is parsed; above </form> the getElementById
  // returns null and the `if(!form) return` guard makes the handler a silent no-op.
  const a = attrs(handler[1]);
  const deferred = (a.src && ('defer' in a || a.type === 'module')) || /DOMContentLoaded/.test(body);
  assert.ok(handler.index >= formEnd || deferred, 'handler script runs before the leasing form exists (move it below </form> or defer it)');

  // Every element the handler touches must exist, or the submit path throws mid-flight.
  const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  for (const [, id] of body.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(ids.has(id), `handler looks up #${id}, which is not on the page`);
  }
});
