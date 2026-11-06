/**
 * lead-source.test.mjs — every lead says where the visit came from.
 *
 * WHY (2026-11-05 review): no lead form recorded a landing page, referrer or campaign tag (only self-reported
 * "how did you hear" dropdowns), so there was no way to tell which channel produced a lead, including the weekly
 * owner-outreach letters. script.js now keeps the first page of the visit (utm_* tags only) and the referring
 * hostname in sessionStorage and fills them into hidden fields; JSON-posting scripts read window.ORA_LEAD_SOURCE().
 * The letters print oxfordra.net/owners, a 302 that tags the visit as direct mail.
 *
 * Static checks pin the wiring (Netlify silently drops a field a form does not declare). The browser checks prove
 * first-touch persistence across pages, that non-utm query parameters (gclid, an email) are dropped, and that only
 * the referrer's hostname is kept.
 *
 * Run: npm run test:site   (needs `npm run build` and a chromium binary; PW_CHANNEL=msedge uses an installed Edge)
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

function attrs(tag) {
  const map = {};
  for (const m of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) map[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return map;
}
function formByName(html, name) {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const inputs = [...m[2].matchAll(/<input\b([^>]*)>/gi)].map((i) => attrs(i[1]));
    if (inputs.some((a) => a.name === 'form-name' && a.value === name)) return inputs;
  }
  return null;
}

// Public lead forms: the hidden inputs script.js fills.
const PUBLIC_FORMS = [
  ['contact.html', 'contact'],
  ['tenant-resources.html', 'leasing-inquiry'],
  ['sell-your-building.html', 'owner-submission-intake'],
  ['resources/industrial-building-sale-document-checklist.html', 'checklist-download'],
  ['tenant-application.html', 'commercial-lease-application'],
  ['available-space.html', 'listing-inquiry'],
];
// Declarations for rows a function writes (chat lead; broker ledger): the fields must exist or Netlify drops them.
const DECLARED_FORMS = [
  ['chat-lead-form.html', 'chat-lead'],
  ['broker-ledger-form.html', 'broker-network-ledger'],
];

test('every public lead form carries the two hidden lead-source fields script.js fills', () => {
  for (const [file, name] of PUBLIC_FORMS) {
    const inputs = formByName(read(file), name);
    assert.ok(inputs, `${file}: form ${name} not found`);
    for (const [field, which] of [['lead-landing', 'landing'], ['lead-referrer', 'referrer']]) {
      const input = inputs.find((a) => a.name === field);
      assert.ok(input, `${file}#${name}: no ${field} input`);
      assert.equal(input.type, 'hidden', `${file}#${name}: ${field} must be hidden`);
      assert.equal(input['data-lead-source'], which, `${file}#${name}: ${field} needs data-lead-source="${which}"`);
    }
  }
});

test('the chat-lead and broker-ledger declarations declare the lead-source fields their functions post', () => {
  for (const [file, name] of DECLARED_FORMS) {
    const inputs = formByName(read(file), name);
    assert.ok(inputs, `${file}: form ${name} not found`);
    for (const field of ['lead-landing', 'lead-referrer']) assert.ok(inputs.some((a) => a.name === field), `${file}#${name}: ${field} not declared`);
  }
  assert.match(read('netlify/functions/chat-lead.js'), /params\.append\('lead-landing'/);
  assert.match(read('netlify/functions/broker-finalize.mjs'), /'lead-landing': sanitizeField\(body\.leadLanding/);
  assert.match(read('assets/chat.js'), /ORA_LEAD_SOURCE/);
  assert.match(read('broker-upload.js'), /ORA_LEAD_SOURCE/);
  assert.match(read('listings.js'), /ORA_LEAD_SOURCE/);
});

test('/owners is a 302 to the owner page tagged as direct mail, ahead of the catch-all', () => {
  const lines = read('_redirects').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const i = lines.findIndex((l) => l.split(/\s+/)[0] === '/owners');
  assert.ok(i >= 0, 'no /owners rule');
  const [, to, status] = lines[i].split(/\s+/);
  assert.equal(status, '302', 'a campaign URL must not be a cached-forever 301');
  const target = new URL(to, 'https://oxfordra.net');
  assert.equal(target.pathname, '/sell-your-building');
  assert.equal(target.searchParams.get('utm_source'), 'owner-letter');
  assert.equal(target.searchParams.get('utm_medium'), 'direct-mail');
  assert.equal(target.searchParams.get('utm_campaign'), 'owner-outreach');
  const catchAll = lines.findIndex((l) => l.startsWith('/* '));
  assert.ok(catchAll > i, '/owners must come before the /* catch-all or it 404s');
});

test('the privacy policy discloses the visit-source fields', () => {
  assert.match(read('privacy.html'), /Visit source on forms you send/);
});

let server;
let browser;
before(async () => {
  server = await startServer({ port: 0 });
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
}, { timeout: 120_000 });
after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

async function context() {
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) => (new URL(route.request().url()).origin === server.url ? route.continue() : route.abort()));
  return ctx;
}
const hiddenValues = (page) => page.evaluate(() => ({
  landing: document.querySelector('input[name="lead-landing"]').value,
  referrer: document.querySelector('input[name="lead-referrer"]').value,
}));

test('first touch survives navigation: utm tags kept, other parameters dropped, referrer reduced to its hostname', { timeout: 120_000 }, async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  try {
    const landing = '/sell-your-building?utm_source=owner-letter&utm_medium=direct-mail&utm_campaign=owner-outreach&gclid=abc123&email=someone%40example.com';
    await page.goto(server.url + landing, { waitUntil: 'load', referer: 'https://www.google.com/search?q=sell+my+warehouse' });
    const first = await hiddenValues(page);
    assert.equal(first.landing, '/sell-your-building?utm_source=owner-letter&utm_medium=direct-mail&utm_campaign=owner-outreach');
    assert.equal(first.referrer, 'www.google.com', 'only the hostname, never the search query');
    // A later page in the same tab keeps the FIRST page of the visit, not its own.
    await page.goto(server.url + '/contact', { waitUntil: 'load' });
    assert.deepEqual(await hiddenValues(page), first);
    assert.deepEqual(await page.evaluate(() => window.ORA_LEAD_SOURCE()), first);
  } finally {
    await ctx.close();
  }
});

test('a direct visit records the page and "(none)"; an internal referrer is not reported as a source', { timeout: 120_000 }, async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  try {
    await page.goto(server.url + '/tenant-resources', { waitUntil: 'load' });
    assert.deepEqual(await hiddenValues(page), { landing: '/tenant-resources', referrer: '(none)' });
    const fresh = await ctx.newPage(); // a new tab is a new session: same-site referrer must not count as a source
    await fresh.goto(server.url + '/contact', { waitUntil: 'load', referer: server.url + '/about' });
    assert.deepEqual(await hiddenValues(fresh), { landing: '/contact', referrer: '(none)' });
  } finally {
    await ctx.close();
  }
});
