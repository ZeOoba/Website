// /contact was flagged thin by the 2026-10-05 crawl (291 words). Instead of restating
// claims the site already makes (buy box, close speed, leasing), the page now speaks in a
// plainer, drier voice: a three-step "what happens when you hit send", friendlier form
// copy and one industrial-nerd line. This pins that voice change without letting it drift
// into new claims, and keeps the form behaviour intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'contact.html'), 'utf8').replace(/\r\n/g, '\n');
const main = html.match(/<main id="main-content">([\s\S]*?)<\/main>/)[1];
const text = (s) => s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ');
const section = (main.match(/<section[^>]*aria-label="What happens next"[\s\S]*?<\/section>/) || [''])[0];

test('the header is casual and still makes the one-business-day promise', () => {
  assert.match(main, /<h1[^>]*>Say hello<\/h1>/);
  const intro = main.match(/<p class="section__intro[^"]*">([\s\S]*?)<\/p>/)[1];
  assert.match(intro, /real person reads every message/i);
  assert.match(intro, /Gabriel/);
  assert.match(intro, /one business day/i, 'the response promise must stay in the header');
});

test('"What happens when you hit send" is a single sentence', () => {
  assert.ok(section, 'section aria-label="What happens next" missing');
  assert.match(section, /<h2[^>]*>What happens when you hit send<\/h2>/);
  assert.doesNotMatch(section, /<ol\b|<li\b/, 'the three steps were folded into one sentence');
  const lede = (section.match(/<p class="contact-lede[^"]*">([\s\S]*?)<\/p>/) || [])[1];
  assert.ok(lede, 'p.contact-lede missing');
  const plain = lede.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
  assert.match(plain, /^[^.!?]+[.]$/, `must be exactly one sentence ending in a period: "${plain}"`);
  assert.match(plain, /Gabriel or Eric/);
  assert.match(plain, /not an autoresponder/);
  assert.match(plain, /call/);
  assert.match(plain, /preliminary indication of interest/);
  assert.match(plain, /if the numbers work, we tell you directly/i);
  assert.match(plain, /suspense is not part of our process/i);
});

test('the voice is dry: the nerd line, the aside and the form copy are in place', () => {
  assert.match(main, /genuinely excited about loading docks, drive-in doors and clear heights\. Consider yourself warned\./);
  assert.match(main, /usually Gabriel, sometimes Eric \(we checked\)/);
  assert.match(main, /placeholder="Tell us about the building\. Leaky roofs and deferred maintenance welcome\."/);
  assert.match(main, /<option value="Just saying hi">Not sure, just saying hi<\/option>/);
});

test('the button and its script agree, and the old stiff labels are gone', () => {
  assert.match(main, /<button type="submit"[^>]*>Send it our way<\/button>/, 'markup button label');
  assert.match(main, /btn\.textContent = 'Send it our way';/, 'the script must restore the same label after an error');
  assert.doesNotMatch(main, /Send Message/);
  assert.match(main, /id="contactSuccess"[^>]*>[^<]*real person[^<]*one business day/i);
});

test('no new claims and no repeats', () => {
  const t = text(section);
  assert.doesNotMatch(t, /all-cash|all cash/i, 'the all-cash claim is under review; do not add it here');
  assert.doesNotMatch(t, /Indianapolis/i);
  assert.doesNotMatch(t, /\$1M|\$10M|50,000|30.{1,3}45 days/, 'buy box and close speed live on for-brokers/sell-your-building; do not repeat them here');
  assert.doesNotMatch(t, /OM &amp; rent roll|Owner intake|Tenant resources/);
  // The new header, placeholder and success copy are outside the section: scan all of <main>.
  const all = text(main) + ' ' + [...main.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]).join(' ');
  assert.doesNotMatch(all, /all-cash|all cash|Indianapolis/i, 'no ruled-out claim anywhere in the page body');
});

test('the page still clears the crawler thin-content bar (< 300 words)', () => {
  const words = text(html).split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 320, `only ${words} visible words on the page`);
});
