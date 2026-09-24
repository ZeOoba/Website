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
