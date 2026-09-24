// Guards script.js's client-side validator for form[data-netlify="true"].
//
// The validator sets `novalidate` on each form, which switches native browser
// validation off, then checked every required field with `value.trim()`. A
// checkbox's `value` is its fixed value attribute ("yes"), not whether it is
// ticked, so an unticked required consent box passed and the owner form posted
// without `tcpa-consent` (found by the PR #88 merge gate, 2026-09-23). Latent in
// production only because Netlify strips data-netlify from served HTML; nothing
// may depend on that stripping.
//
// script.js is hand-minified with no exports, so this test lifts the validator's
// setup function out of the source and runs it against a minimal DOM stub whose
// forms are built from the real page markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(path.join(ROOT, 'script.js'), 'utf8');

// Parse attributes into a map; never assume attribute order or quote style.
function attrs(tag) {
  const map = {};
  for (const m of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    map[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return map;
}

function formFields(file, formId) {
  const html = readFileSync(path.join(ROOT, file), 'utf8');
  const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].find((m) => attrs(m[1]).id === formId);
  assert.ok(form, `${file}#${formId} not found`);
  return [...form[2].matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].map((m) => ({ tag: m[1].toLowerCase(), attrs: attrs(m[2]) }));
}

/* ---------- Minimal DOM stub: just what the validator touches ---------- */

class El {
  constructor(tag, a = {}) {
    this.tagName = tag;
    this.attrs = { ...a };
    this.children = [];
    this.parentNode = null;
    this.id = a.id ?? '';
    this.name = a.name ?? '';
    this.type = tag === 'input' ? a.type ?? 'text' : tag === 'select' ? 'select-one' : tag === 'button' ? a.type ?? 'submit' : tag;
    this.value = tag === 'input' && ['checkbox', 'radio'].includes(this.type) ? a.value ?? 'on' : '';
    this.checked = 'checked' in a;
    this.className = a.class ?? '';
    this.textContent = '';
    this.focused = false;
  }
  hasAttribute(k) { return k in this.attrs; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  get nextSibling() {
    const sib = this.parentNode?.children;
    return sib ? sib[sib.indexOf(this) + 1] ?? null : null;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  matches(sel) {
    return sel.split(',').some((s) => {
      s = s.trim();
      if (s.startsWith('.')) return this.className.split(/\s+/).includes(s.slice(1));
      if (s.startsWith('[')) {
        const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
        if (m[1] === 'type') return this.type === m[2];
        return m[2] === undefined ? this.hasAttribute(m[1]) : this.getAttribute(m[1]) === m[2];
      }
      return this.tagName === s;
    });
  }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) if (n.matches?.(sel)) return n;
    return null;
  }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(sel) { return this.descendants().filter((d) => d.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  focus() { this.focused = true; }
  // Constraint-validation valueMissing, per the HTML spec for each control type.
  get validity() {
    if (this.type === 'checkbox') return { valueMissing: this.hasAttribute('required') && !this.checked };
    if (this.type === 'radio') {
      const form = this.closest('form');
      const group = form.querySelectorAll('input').filter((r) => r.type === 'radio' && r.name === this.name);
      return { valueMissing: group.some((r) => r.hasAttribute('required')) && !group.some((r) => r.checked) };
    }
    return { valueMissing: this.hasAttribute('required') && this.value === '' };
  }
}

class Form extends El {
  constructor() { super('form', { 'data-netlify': 'true' }); this.handlers = []; }
  addEventListener(type, fn) { if (type === 'submit') this.handlers.push(fn); }
  submit() {
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const h of this.handlers) h(ev);
    return ev.defaultPrevented;
  }
}

// Each field sits in its own .form-group wrapper, as on the real pages.
function buildForm(fields) {
  const form = new Form();
  const els = {};
  for (const f of fields) {
    const group = form.appendChild(new El('div', { class: 'form-group' }));
    const el = group.appendChild(new El(f.tag, f.attrs));
    group.appendChild(new El('label'));
    els[f.attrs.id || `${f.attrs.name}=${f.attrs.value}`] = el;
  }
  form.appendChild(new El('button', { type: 'submit' }));
  const document = {
    createElement: (tag) => new El(tag),
    getElementById: (id) => form.descendants().find((d) => d.id === id) ?? null,
  };
  const setup = SCRIPT.match(/function a\(\)\{var e=i\('form\[data-netlify="true"\]'\)[\s\S]*?(?=function r\(\)\{var e=i\("\.hero__stat-value)/);
  assert.ok(setup, 'validator setup function not found in script.js; update this test if the minified code moved');
  new Function('i', 'document', `${setup[0]}; return a;`)(() => [form], document)();
  assert.equal(form.hasAttribute('novalidate'), true, 'validator did not attach');
  return { form, els };
}

const FILL = { email: 'owner@example.com', tel: '614-555-0100' };

function fillRequiredText(els) {
  for (const el of Object.values(els)) {
    if (el.hasAttribute('required') && !['checkbox', 'radio', 'hidden'].includes(el.type)) el.value = FILL[el.type] ?? 'x';
  }
}

function errorFor(form, el) {
  return form.descendants().find((d) => d.id === `${el.id || el.name}-error`) ?? null;
}

/* ---------- Owner form (sell-your-building.html) ---------- */

test('owner form blocks submit when the required consent box is unticked', () => {
  const { form, els } = buildForm(formFields('sell-your-building.html', 'ownerForm'));
  const consent = els['owner-consent'];
  assert.equal(consent.type, 'checkbox');
  assert.ok(consent.hasAttribute('required'), 'owner-consent must stay required');
  fillRequiredText(els);
  consent.checked = false;

  assert.equal(form.submit(), true, 'submit was not prevented: the form would post without tcpa-consent');
  assert.equal(consent.getAttribute('aria-invalid'), 'true');
  assert.ok(consent.focused, 'focus should move to the consent box');
  const err = errorFor(form, consent);
  assert.ok(err, 'no error message rendered for the consent box');
  assert.match(err.textContent, /check this box/i);
  // Not wedged between the box and its label inside the flex row.
  assert.notEqual(err.parentNode, consent.parentNode, 'consent error must render outside the checkbox row');
  assert.equal(consent.parentNode.nextSibling, err, 'consent error should follow its .form-group');
});

test('owner form submits when the consent box is ticked, and clears the prior error', () => {
  const { form, els } = buildForm(formFields('sell-your-building.html', 'ownerForm'));
  const consent = els['owner-consent'];
  fillRequiredText(els);
  consent.checked = false;
  assert.equal(form.submit(), true);

  consent.checked = true;
  assert.equal(form.submit(), false, 'a ticked consent box must not block submit');
  assert.equal(consent.hasAttribute('aria-invalid'), false);
  assert.equal(errorFor(form, consent), null, 'stale consent error left on the page');
});

test('owner form still blocks an empty required text field', () => {
  const { form, els } = buildForm(formFields('sell-your-building.html', 'ownerForm'));
  fillRequiredText(els);
  els['owner-consent'].checked = true;
  els['owner-address'].value = '   ';

  assert.equal(form.submit(), true);
  assert.equal(els['owner-address'].getAttribute('aria-invalid'), 'true');
  assert.equal(errorFor(form, els['owner-address']).textContent, 'This field is required.');
  assert.equal(errorFor(form, els['owner-address']).parentNode, els['owner-address'].parentNode, 'text-field errors stay beside the input');
});

/* ---------- Lease application (tenant-application.html) ---------- */

function applicationChoiceFields() {
  const fields = formFields('tenant-application.html', 'applicationForm');
  const broker = fields.filter((f) => f.attrs.name === 'working-with-broker');
  const terms = fields.filter((f) => f.attrs.name === 'agree-terms');
  assert.equal(broker.length, 2);
  assert.ok(broker.every((f) => f.attrs.type === 'radio'));
  assert.ok(broker.some((f) => 'required' in f.attrs), 'working-with-broker group must stay required');
  assert.equal(terms.length, 1);
  assert.equal(terms[0].attrs.type, 'checkbox');
  assert.ok('required' in terms[0].attrs, 'agree-terms must stay required');
  return [...broker, ...terms];
}

test('lease application blocks an unanswered required radio group and an unticked terms box', () => {
  const { form, els } = buildForm(applicationChoiceFields());
  assert.equal(form.submit(), true, 'submit was not prevented');
  const yes = els['working-with-broker=Yes'];
  assert.equal(yes.getAttribute('aria-invalid'), 'true');
  assert.match(errorFor(form, yes).textContent, /select an option/i);
  assert.equal(els['agree-terms'].getAttribute('aria-invalid'), 'true');
  assert.match(errorFor(form, els['agree-terms']).textContent, /check this box/i);
});

test('lease application accepts either radio answer once the terms box is ticked', () => {
  for (const answer of ['Yes', 'No']) {
    const { form, els } = buildForm(applicationChoiceFields());
    els[`working-with-broker=${answer}`].checked = true;
    els['agree-terms'].checked = true;
    assert.equal(form.submit(), false, `answer "${answer}" was blocked`);
    assert.equal(form.querySelectorAll('[aria-invalid]').length, 0);
  }
});

/* ---------- File uploads: honour each input's own accept attribute ---------- */
// The validator used to check every upload against one PDF/Excel/Word MIME
// allowlist, so the lease application's accept=".pdf,.jpg,.jpeg,.png" inputs
// rejected a photographed driver's licence (found by the PR #91 reviewer,
// 2026-09-23). The allowlist is now only the fallback for inputs with no accept.

const MB = 1024 * 1024;

// A chosen file, as the browser exposes it: value is the fakepath, files holds {name, type, size}.
function choose(el, name, type, size = MB) {
  el.value = `C:\\fakepath\\${name}`;
  el.files = [{ name, type, size }];
}

function uploadFields(file, formId) {
  const fields = formFields(file, formId).filter((f) => f.attrs.type === 'file');
  assert.ok(fields.length > 0, `${file}#${formId} has no file inputs`);
  return fields;
}

function applicationUploads() {
  const fields = uploadFields('tenant-application.html', 'applicationForm');
  for (const f of fields) assert.equal(f.attrs.accept, '.pdf,.jpg,.jpeg,.png', `${f.attrs.id} accept list changed; update this test`);
  return fields;
}

test('lease application accepts every upload type its accept attribute allows', () => {
  const cases = [
    ['licence.jpg', 'image/jpeg'],
    ['licence.jpeg', 'image/jpeg'],
    ['licence.png', 'image/png'],
    ['licence.pdf', 'application/pdf'],
    ['SCAN.JPG', ''], // extension match is case-insensitive and needs no browser-reported MIME type
  ];
  for (const [name, type] of cases) {
    const { form, els } = buildForm(applicationUploads());
    for (const el of Object.values(els)) choose(el, name, type);
    assert.equal(form.submit(), false, `${name} (${type || 'no MIME'}) was rejected`);
    assert.equal(form.querySelectorAll('[aria-invalid]').length, 0);
  }
});

test('lease application rejects an upload outside its accept list, naming the accepted formats', () => {
  const { form, els } = buildForm(applicationUploads());
  for (const el of Object.values(els)) choose(el, 'licence.pdf', 'application/pdf');
  // A Word file passed the old global allowlist, but this input does not accept it.
  const licence = els['upload-drivers-license'];
  choose(licence, 'licence.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  assert.equal(form.submit(), true, 'a .docx upload was not blocked');
  assert.equal(licence.getAttribute('aria-invalid'), 'true');
  assert.equal(errorFor(form, licence).textContent, 'Accepted formats: PDF, JPG, JPEG, PNG.');
});

test('accept tokens match by extension, exact MIME type, or MIME wildcard', () => {
  const field = (accept) => [{ tag: 'input', attrs: { type: 'file', id: 'doc', name: 'doc', accept } }];
  const check = (accept, name, type) => {
    const { form, els } = buildForm(field(accept));
    choose(els.doc, name, type);
    return !form.submit();
  };
  // The broker upload's accept list (for-brokers.html), in case data-netlify returns to that form.
  const broker = uploadFields('for-brokers.html', 'brokerForm')[0].attrs.accept;
  assert.equal(check(broker, 'rent-roll.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
  assert.equal(check(broker, 'om.docx', ''), true);
  assert.equal(check(broker, 'photo.jpg', 'image/jpeg'), false);
  assert.equal(check('image/png', 'a.png', 'image/png'), true);
  assert.equal(check('image/png', 'a.jpg', 'image/jpeg'), false);
  assert.equal(check('image/*', 'a.jpg', 'image/jpeg'), true);
  assert.equal(check('image/*', 'a.pdf', 'application/pdf'), false);
  assert.equal(check(' .PDF , .Png ', 'a.png', 'image/png'), true, 'tokens are trimmed and case-insensitive');
  assert.equal(check('.pdf', 'pdf', ''), false, 'a bare name ending in the letters is not the extension');
});

test('an upload input without accept falls back to the PDF/Excel/Word allowlist', () => {
  const field = [{ tag: 'input', attrs: { type: 'file', id: 'doc', name: 'doc' } }];
  let { form, els } = buildForm(field);
  choose(els.doc, 'om.pdf', 'application/pdf');
  assert.equal(form.submit(), false);

  ({ form, els } = buildForm(field));
  choose(els.doc, 'photo.png', 'image/png');
  assert.equal(form.submit(), true);
  assert.equal(errorFor(form, els.doc).textContent, 'Accepted formats: PDF, Excel, Word.');
});

test('the 10 MB limit still applies to an accepted type', () => {
  const { form, els } = buildForm(applicationUploads());
  for (const el of Object.values(els)) choose(el, 'licence.jpg', 'image/jpeg');
  choose(els['upload-articles'], 'articles.pdf', 'application/pdf', 11 * MB);
  assert.equal(form.submit(), true);
  assert.equal(errorFor(form, els['upload-articles']).textContent, 'File must be under 10 MB.');
});

test('a required upload with no file chosen is still blocked', () => {
  const { form, els } = buildForm(applicationUploads());
  for (const el of Object.values(els)) choose(el, 'licence.jpg', 'image/jpeg');
  const articles = els['upload-articles'];
  articles.value = '';
  articles.files = [];
  assert.equal(form.submit(), true);
  assert.equal(errorFor(form, articles).textContent, 'This field is required.');
});

/* ---------- Cache-buster ---------- */

test('every page loads script.js with the same cache-buster', () => {
  const versions = new Map();
  const walk = (dir) => {
    for (const ent of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!['node_modules', 'dist', '.git', '.claude', 'tests'].includes(ent.name)) walk(rel);
      } else if (ent.name.endsWith('.html')) {
        for (const m of readFileSync(path.join(ROOT, rel), 'utf8').matchAll(/["/]script\.js\?v=([^"'&]+)/g)) {
          versions.set(m[1], [...(versions.get(m[1]) ?? []), rel]);
        }
      }
    }
  };
  walk('');
  assert.ok(versions.size > 0, 'no page loads script.js');
  assert.equal(versions.size, 1, `mixed script.js versions: ${JSON.stringify(Object.fromEntries(versions))}`);
});
