/**
 * upload-budget.test.mjs — proves, in a real browser, that an over-budget upload
 * on the lease application cannot be submitted.
 *
 * WHY THIS EXISTS: two independent client validators guard the same three file
 * inputs. script.js applies a flat 10 MB per-file cap to every form[data-netlify];
 * application-script.js applies the real, tighter budgets (4.0 / 1.5 / 1.5 MB,
 * 7.0 MB total, because Netlify Forms rejects a whole submission over 8 MB) with
 * setCustomValidity(), and only its own validateStep() honours that. Between 1.5
 * and 10 MB a driver's-licence scan passes script.js and is stopped solely by
 * application-script.js. The unit test covers the arithmetic (sumSelectedBytes);
 * nothing covered "the form does not post". A reorder or refactor of either
 * script could reopen the failure silently: three real documents that jointly
 * exceed Netlify's true cap, and a submission that is lost after the applicant
 * believes they applied.
 *
 * Every scenario submits through the real click path with a fully valid step 4
 * except the file under test. The control scenario must POST, so a harness that
 * can never submit cannot pass the blocked scenarios vacuously.
 *
 * Run: npm run test:site   (requires `npm run build`; PW_CHANNEL=msedge uses an
 *      installed Edge instead of the bundled Chromium)
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve-dist.mjs';

const MB = 1024 * 1024;
const pdf = (name, bytes) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(bytes, 0x25) });

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

// Open the application, jump to step 4 and fill everything in it except the
// three uploads. Returns the page plus the list of POSTs the form attempted.
async function openStep4() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const posts = [];
  await page.route('**/*', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      posts.push(req.url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>received</title>' });
    }
    // Third-party scripts are irrelevant here and only slow the run.
    if (!req.url().startsWith(server.url)) return route.abort();
    return route.continue();
  });
  await page.goto(`${server.url}/tenant-application.html`, { waitUntil: 'load' });

  await page.evaluate(() => {
    document.querySelectorAll('.app-step').forEach((s) => { s.style.display = s.dataset.step === '4' ? '' : 'none'; });
    document.getElementById('btnSubmit').style.display = '';
    // script.js's generic validator checks EVERY control in the form, not just the
    // visible step, so a realistic submit needs all four steps filled in.
    const form = document.getElementById('applicationForm');
    for (const el of form.querySelectorAll('input, select, textarea')) {
      if (el.type === 'file' || el.type === 'hidden' || !el.hasAttribute('required')) continue;
      if (el.type === 'checkbox') el.checked = true;
      else if (el.type === 'radio') form.querySelector(`input[type="radio"][name="${el.name}"]`).checked = true;
      else if (el.tagName === 'SELECT') el.value = [...el.options].find((o) => o.value)?.value ?? '';
      else if (el.type === 'date') el.value = '2026-09-28';
      else if (el.type === 'email') el.value = 'applicant@example.com';
      else if (el.type === 'tel') el.value = '(555) 555-5555';
      else el.value = 'Test Applicant';
    }
  });
  return { page, posts, context };
}

async function attach(page, files) {
  await page.setInputFiles('#upload-credit-report', files.credit);
  await page.setInputFiles('#upload-drivers-license', files.license);
  await page.setInputFiles('#upload-articles', files.articles);
}

// Names of controls that block the form (browser-invalid, or flagged by script.js's
// validator): makes a failed control scenario say WHICH field blocked it instead of
// just "0 !== 1".
const invalidFields = (page) => page.evaluate(() => [...document.querySelectorAll('#applicationForm input, #applicationForm select, #applicationForm textarea')]
  .filter((el) => el.type !== 'hidden' && (!el.checkValidity() || el.getAttribute('aria-invalid') === 'true')).map((el) => `${el.name || el.id} (${el.validationMessage || el.getAttribute('aria-describedby')})`));

async function submit(page) {
  await page.click('#btnSubmit');
  // A POST, if the form sends one, is issued synchronously after the submit event.
  await page.waitForTimeout(400);
}

test('control: three in-budget documents submit (so the blocked cases below are not vacuous)', async () => {
  const { page, posts, context } = await openStep4();
  await attach(page, { credit: pdf('credit.pdf', 3 * MB), license: pdf('license.pdf', 1 * MB), articles: pdf('articles.pdf', 1 * MB) });
  await submit(page);
  assert.equal(posts.length, 1, `a fully valid, in-budget application must post exactly once; invalid controls: ${JSON.stringify(await invalidFields(page))}`);
  await context.close();
});

test('a driver\'s licence over its 1.5 MB cap but under script.js\'s 10 MB cap is blocked by application-script.js, and says why', async () => {
  const { page, posts, context } = await openStep4();
  await attach(page, { credit: pdf('credit.pdf', 1 * MB), license: pdf('license.pdf', 3 * MB), articles: pdf('articles.pdf', 1 * MB) });
  await submit(page);
  assert.equal(posts.length, 0, 'the over-budget licence scan was submitted: Netlify would reject the whole application');
  const state = await page.evaluate(() => {
    const input = document.getElementById('upload-drivers-license');
    return { message: input.validationMessage, invalid: input.classList.contains('invalid'), hint: input.parentElement.querySelector('.file-upload-hint')?.textContent ?? '' };
  });
  assert.equal(state.message, 'File exceeds the per-field limit.');
  assert.ok(state.invalid, 'the offending input is not marked invalid');
  assert.match(state.hint, /too large/i, 'the applicant is not told which file is the problem');
  await context.close();
});

test('a file over script.js\'s flat 10 MB cap is blocked too', async () => {
  const { page, posts, context } = await openStep4();
  await attach(page, { credit: pdf('credit.pdf', 11 * MB), license: pdf('license.pdf', 1 * MB), articles: pdf('articles.pdf', 1 * MB) });
  await submit(page);
  assert.equal(posts.length, 0, 'an 11 MB upload was submitted');
  await context.close();
});

test('fixing the file clears the block: replacing the oversized scan lets the application post', async () => {
  const { page, posts, context } = await openStep4();
  await attach(page, { credit: pdf('credit.pdf', 1 * MB), license: pdf('license.pdf', 3 * MB), articles: pdf('articles.pdf', 1 * MB) });
  await submit(page);
  assert.equal(posts.length, 0);
  await page.setInputFiles('#upload-drivers-license', pdf('license-small.pdf', 1 * MB));
  await submit(page);
  assert.equal(posts.length, 1, 'the block did not lift after the applicant replaced the file');
  await context.close();
});
