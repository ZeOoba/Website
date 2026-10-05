/**
 * contact-form-hint.test.mjs: in a real browser, proves two things about /contact.
 *
 * 1. The message box's placeholder follows the Subject dropdown, so a leasing or tenant
 *    visitor is not told to "tell us about the building". The copy lives in each option's
 *    data-hint attribute; the page script only copies it into the textarea.
 * 2. The navy header does not carry a big empty block under its content any more.
 *
 * Run: npm run test:site   (needs `npm run build` and a chromium binary)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

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

const HINTS = {
  'Acquisition Opportunity': 'Tell us about the building. Leaky roofs and deferred maintenance welcome.',
  'Leasing Inquiry': 'Tell us about the space you need: size, timing and what it will be used for.',
  'Tenant Support': 'Tell us what is going on and which suite or property you are in.',
  General: 'Ask us anything. Industrial real estate questions are our favorite kind.',
  'Just saying hi': 'Say hi. We will say hi back.',
};

async function openContact(viewport, search = '') {
  const context = await browser.newContext({ viewport });
  // Same-origin only: analytics, chat, maps and reCAPTCHA must not make this flaky.
  await context.route('**/*', (route) => (route.request().url().startsWith(server.url) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${server.url}/contact${search}`, { waitUntil: 'load' });
  return { context, page, errors };
}

test('the message placeholder starts matching the default subject and follows every subject choice', { timeout: 120_000 }, async () => {
  const { context, page, errors } = await openContact({ width: 1280, height: 900 });
  try {
    const placeholder = () => page.$eval('#contact-message', (el) => el.placeholder);
    const defaultSubject = await page.$eval('#contact-subject', (el) => el.value);
    assert.equal(await placeholder(), HINTS[defaultSubject], 'initial placeholder must match the default subject');
    for (const [subject, hint] of Object.entries(HINTS)) {
      await page.selectOption('#contact-subject', subject);
      assert.equal(await placeholder(), hint, `placeholder after choosing "${subject}"`);
    }
    // Back to the first option: it must return, not stay on the last hint.
    await page.selectOption('#contact-subject', 'Acquisition Opportunity');
    assert.equal(await placeholder(), HINTS['Acquisition Opportunity']);
    // What they typed is never touched by a subject change.
    await page.fill('#contact-message', 'Two units, 3,000 SF each.');
    await page.selectOption('#contact-subject', 'Leasing Inquiry');
    assert.equal(await page.inputValue('#contact-message'), 'Two units, 3,000 SF each.');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await context.close();
  }
});

test('after Back, the browser restores the chosen subject and the placeholder follows it', { timeout: 120_000 }, async () => {
  const { context, page } = await openContact({ width: 1280, height: 900 });
  try {
    await page.selectOption('#contact-subject', 'Tenant Support');
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await page.goBack({ waitUntil: 'load' });
    // The browser restores the select at pageshow, after DOMContentLoaded/load and with no change event.
    await page.waitForFunction(() => document.querySelector('#contact-subject').value === 'Tenant Support');
    assert.equal(await page.$eval('#contact-message', (el) => el.placeholder), HINTS['Tenant Support'], 'stale placeholder after Back');
  } finally {
    await context.close();
  }
});

// Deep links: /contact?subject=<key> preselects the subject (and so the placeholder).
// Only the keys below are honoured; anything else falls back to the default.
const DEEP_LINKS = [
  ['?subject=leasing', 'Leasing Inquiry'],
  ['?subject=TENANT', 'Tenant Support'],
  ['?subject=acquisition', 'Acquisition Opportunity'],
  ['?subject=general', 'General'],
  ['?subject=hi', 'Just saying hi'],
  ['?subject=nonsense', 'Acquisition Opportunity'],
  ['?subject=', 'Acquisition Opportunity'],
  ['?subject=%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'Acquisition Opportunity'],
  ['?subject=Leasing%20Inquiry', 'Acquisition Opportunity'], // keys only, not display values
];
for (const [search, want] of DEEP_LINKS) {
  test(`deep link ${search || '(empty)'} selects "${want}" and the matching placeholder`, { timeout: 120_000 }, async () => {
    const { context, page, errors } = await openContact({ width: 1280, height: 900 }, search);
    try {
      assert.equal(await page.$eval('#contact-subject', (el) => el.value), want);
      assert.equal(await page.$eval('#contact-message', (el) => el.placeholder), HINTS[want]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test('a visitor can still change the subject after a deep link', { timeout: 120_000 }, async () => {
  const { context, page } = await openContact({ width: 1280, height: 900 }, '?subject=leasing');
  try {
    await page.selectOption('#contact-subject', 'General');
    assert.equal(await page.$eval('#contact-message', (el) => el.placeholder), HINTS.General);
  } finally {
    await context.close();
  }
});

// After a successful send, the While you wait panel shows only the links that fit the subject
// (all of them for General / just saying hi). The POST to / is simulated; nothing is sent.
const ALL = ['/resources/', '/for-brokers#broker-network', '/available-space', '/tenant-resources'];
const AFTER_SEND = [
  ['Acquisition Opportunity', ['/resources/', '/for-brokers#broker-network']],
  ['Leasing Inquiry', ['/available-space']],
  ['Tenant Support', ['/tenant-resources']],
  ['General', ALL],
  ['Just saying hi', ALL],
];
for (const [subject, want] of AFTER_SEND) {
  test(`after sending as "${subject}" the While you wait panel shows the matching links`, { timeout: 120_000 }, async () => {
    const { context, page, errors } = await openContact({ width: 1280, height: 900 });
    try {
      let posts = 0;
      await context.route(`${server.url}/`, (route) => {
        if (route.request().method() === 'POST') { posts += 1; return route.fulfill({ status: 200, body: 'ok' }); }
        return route.continue();
      });
      await page.selectOption('#contact-subject', subject);
      await page.fill('#contact-name', 'Test Person');
      await page.fill('#contact-email', 'test@example.com');
      await page.fill('#contact-message', 'Automated test, nothing is sent.');
      await page.click('#contactForm button[type="submit"]');
      await page.waitForSelector('#contactSuccess', { state: 'visible' });
      assert.equal(posts, 1, 'exactly one simulated POST');
      assert.match(await page.$eval('#contactSuccess p[role="alert"]', (el) => el.textContent), /real person.*one business day/);
      const hrefs = await page.$$eval('.contact-wait__item', (els) => els.filter((e) => e.offsetParent !== null).flatMap((e) => [...e.querySelectorAll('a')].map((a) => a.getAttribute('href'))));
      assert.deepEqual(hrefs, want);
      assert.equal(await page.isVisible('#contact-name'), false, 'fields are hidden after a successful send');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test('every subject option has a unique data-key, and Available Space links to the leasing deep link',{ timeout: 120_000 }, async () => {
  const { context, page } = await openContact({ width: 1280, height: 900 });
  try {
    const keys = await page.$$eval('#contact-subject option', (os) => os.map((o) => o.getAttribute('data-key')));
    assert.deepEqual(keys, ['acquisition', 'leasing', 'tenant', 'general', 'hi']);
  } finally {
    await context.close();
  }
  const fs = await import('node:fs');
  const avail = fs.readFileSync(new URL('../../available-space.html', import.meta.url), 'utf8');
  assert.ok(avail.includes('<a href="/contact?subject=leasing" class="btn btn--gold">Tell Us What You Need</a>'), 'Available Space CTA must use the leasing deep link');
});

test('every subject option carries its own distinct hint, and every hint is tested here',{ timeout: 120_000 }, async () => {
  const { context, page } = await openContact({ width: 1280, height: 900 });
  try {
    const opts = await page.$$eval('#contact-subject option', (os) => os.map((o) => [o.value, o.getAttribute('data-hint')]));
    assert.deepEqual(opts.map(([v]) => v).sort(), Object.keys(HINTS).sort(), 'subject options and tested hints must match');
    for (const [value, hint] of opts) assert.ok(hint && hint.length > 10, `"${value}" has no data-hint`);
    assert.equal(new Set(opts.map(([, h]) => h)).size, opts.length, 'hints must differ');
  } finally {
    await context.close();
  }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`the header leaves no big empty block under its content at ${viewport.width}px`, { timeout: 120_000 }, async () => {
    const { context, page } = await openContact(viewport);
    try {
      const gap = await page.evaluate(() => {
        const section = document.querySelector('section[aria-label="Page header"]');
        const last = section.querySelector('.contact-aside');
        return Math.round(section.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
      });
      assert.ok(gap >= 32 && gap <= 72, `gap under the header content is ${gap}px; expected 32 to 72`);
    } finally {
      await context.close();
    }
  });
}
