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

async function openContact(viewport) {
  const context = await browser.newContext({ viewport });
  // Same-origin only: analytics, chat, maps and reCAPTCHA must not make this flaky.
  await context.route('**/*', (route) => (route.request().url().startsWith(server.url) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${server.url}/contact`, { waitUntil: 'load' });
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
