'use strict';
// Unit tests for scripts/lib/form-hooks.mjs (the logic behind scripts/check-form-hooks.mjs). No network: the
// fixture is the shape of the site's live hooks read on 2026-11-05, with placeholder URLs and secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const load = () => import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'form-hooks.mjs')).href);

const SECRET = 'SIGNATURE-SECRET-MUST-NEVER-PRINT';
const fnHook = (fn, form, extra = {}) => ({ type: 'url', event: 'submission_created', form_name: form, disabled: false, data: { url: `https://oxfordra.net/.netlify/functions/${fn}`, signature_secret: SECRET }, ...extra });
// The live config on 2026-11-05: note there is NO hook for owner-lead-notify.
const LIVE = [
  { type: 'email', event: 'submission_created', form_name: null, disabled: null, data: { email: 'ggoldberg@oxfordra.net' } },
  { type: 'url', event: 'submission_created', form_name: 'commercial-lease-application', disabled: false, data: { url: 'https://hooks.example-automation.com/hooks/standard/1/abc/' } },
  { type: 'email', event: 'submission_created', form_name: 'chat-lead', disabled: null, data: { email: 'ggoldberg@oxfordra.net', subject: 'Chat lead' } },
  { type: 'email', event: 'submission_created', form_name: 'chat-lead', disabled: null, data: { email: 'egoldberg@oxfordra.net', subject: 'Chat lead' } },
  { type: 'github_app_checks', event: 'deploy_building', form_name: null, disabled: false, data: {} },
  fnHook('tenant-application-processor', null),
  fnHook('contact-notify', 'contact', { disabled: null }),
  fnHook('checklist-notify', 'checklist-download'),
];
const TARGETS = [
  { fn: 'checklist-notify', form: 'checklist-download' },
  { fn: 'contact-notify', form: 'contact' },
  { fn: 'owner-lead-notify', form: 'owner-submission-intake' },
  { fn: 'tenant-application-processor', form: 'commercial-lease-application' },
];
const FORMS = ['broker-network-ledger', 'broker-submission-intake', 'chat-lead', 'checklist-download', 'commercial-lease-application', 'contact', 'leasing-inquiry', 'listing-inquiry', 'owner-submission-intake', 'pipeline-failures'];

test('the real notify functions are found as webhook targets with the form each one watches', async () => {
  const { webhookTargets } = await load();
  const dir = path.join(ROOT, 'netlify', 'functions');
  const sources = Object.fromEntries(fs.readdirSync(dir).filter((f) => /\.m?js$/.test(f)).map((f) => [`netlify/functions/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]));
  assert.deepEqual(webhookTargets(sources), TARGETS);
});

test('the 2026-11-05 live config fails on exactly one thing: owner-lead-notify is not wired', async () => {
  const { auditFormHooks } = await load();
  const { problems, notes } = auditFormHooks({ hooks: LIVE, targets: TARGETS, forms: FORMS });
  assert.deepEqual(problems.map((p) => `${p.kind}:${p.fn || p.form}`), ['unregistered:owner-lead-notify']);
  assert.match(problems[0].fix, /owner-submission-intake/);
  assert.ok(notes.some((n) => n.kind === 'external' && /commercial-lease-application/.test(n.detail)), 'the external lease-application hook is reported');
});

test('registering the owner hook (scoped to its form, or to every form) clears it', async () => {
  const { auditFormHooks } = await load();
  for (const scope of ['owner-submission-intake', null]) {
    const { problems } = auditFormHooks({ hooks: [...LIVE, fnHook('owner-lead-notify', scope)], targets: TARGETS, forms: FORMS });
    assert.deepEqual(problems, [], `scope ${scope}`);
  }
});

test('a hook scoped to the wrong form, or disabled, does not count', async () => {
  const { auditFormHooks } = await load();
  const wrong = auditFormHooks({ hooks: [...LIVE, fnHook('owner-lead-notify', 'contact')], targets: TARGETS, forms: FORMS });
  assert.equal(wrong.problems.length, 1);
  assert.match(wrong.problems[0].detail, /scoped to contact/);
  const off = auditFormHooks({ hooks: [...LIVE, fnHook('owner-lead-notify', 'owner-submission-intake', { disabled: true })], targets: TARGETS, forms: FORMS });
  assert.deepEqual(off.problems.map((p) => p.fn), ['owner-lead-notify']);
});

test('a hook aimed at another host or over plain http does not count as wiring the function', async () => {
  const { auditFormHooks } = await load();
  const elsewhere = (url) => ({ ...fnHook('owner-lead-notify', 'owner-submission-intake'), data: { url, signature_secret: SECRET } });
  for (const url of [
    'https://deploy-preview-12--snazzy-frangipane-de3841.netlify.app/.netlify/functions/owner-lead-notify',
    'https://oxfordra.example/.netlify/functions/owner-lead-notify',
    'http://oxfordra.net/.netlify/functions/owner-lead-notify',
  ]) {
    const { problems } = auditFormHooks({ hooks: [...LIVE, elsewhere(url)], targets: TARGETS, forms: FORMS });
    assert.deepEqual(problems.map((p) => p.fn), ['owner-lead-notify'], url);
    assert.match(problems[0].detail, /not this site over https/, url);
  }
  // The site's own hosts do count.
  for (const host of ['oxfordra.net', 'www.oxfordra.net', 'snazzy-frangipane-de3841.netlify.app']) {
    const { problems } = auditFormHooks({ hooks: [...LIVE, elsewhere(`https://${host}/.netlify/functions/owner-lead-notify`)], targets: TARGETS, forms: FORMS });
    assert.deepEqual(problems, [], host);
  }
});

test('every address in a notification list is masked', async () => {
  const { maskEmail } = await load();
  assert.equal(maskEmail('ggoldberg@oxfordra.net, egoldberg@oxfordra.net'), 'g***@oxfordra.net, e***@oxfordra.net');
  assert.equal(maskEmail('ggoldberg@oxfordra.net'), 'g***@oxfordra.net');
  assert.equal(maskEmail(''), '***');
});

test('without the all-forms email, forms that only it covered are reported as notifying no one', async () => {
  const { auditFormHooks } = await load();
  const hooks = LIVE.filter((h) => !(h.type === 'email' && h.form_name == null));
  const { problems } = auditFormHooks({ hooks, targets: TARGETS, forms: FORMS });
  const unnotified = problems.filter((p) => p.kind === 'unnotified').map((p) => p.form);
  assert.deepEqual(unnotified, ['broker-network-ledger', 'broker-submission-intake', 'leasing-inquiry', 'listing-inquiry', 'owner-submission-intake', 'pipeline-failures']);
  // Covered another way: chat-lead (its own email hooks), contact / checklist / lease application (wired functions).
  for (const f of ['chat-lead', 'contact', 'checklist-download', 'commercial-lease-application']) assert.ok(!unnotified.includes(f), f);
});

test('the report never contains a signature secret or a full notification address', async () => {
  const { auditFormHooks, formatReport } = await load();
  const text = formatReport(auditFormHooks({ hooks: LIVE, targets: TARGETS, forms: FORMS }));
  assert.ok(!text.includes(SECRET), 'signature secret leaked into the report');
  assert.ok(!/ggoldberg@|egoldberg@/.test(text), 'notification addresses must be masked');
  assert.match(text, /g\*\*\*@oxfordra\.net/);
  assert.match(text, /1 problem/);
});
