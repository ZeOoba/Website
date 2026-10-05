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

test('the header is casual', () => {
  assert.match(main, /<h1[^>]*>Say hello<\/h1>/);
  const header = main.match(/<section[^>]*aria-label="Page header"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(header, /section__intro/, 'the header has one supporting line, the loading-docks aside');
  assert.doesNotMatch(header, /intimidating|always down to talk/i, 'the old subhead was removed on purpose');
  assert.doesNotMatch(header, /real (?:person|human)/i, 'who reads it is said once, in the What happens section');
});

test('the loading-docks line sits in the header, where more people see it', () => {
  const header = main.match(/<section[^>]*aria-label="Page header"[\s\S]*?<\/section>/)[0];
  assert.match(header, /<p class="contact-aside">We get genuinely excited about loading docks, <span class="contact-nowrap">drive-in<\/span> doors and clear heights\. Consider yourself warned\.<\/p>/, 'drive-in must not break across lines');
  assert.doesNotMatch(section, /loading docks/i, 'said once: it moved up out of the bottom section');
  assert.doesNotMatch(section, /class="section__label"/, 'the eyebrow label is removed on purpose');
});

test('the one-business-day promise sits right under the submit button (and not in the lede)', () => {
  assert.match(main, /<button type="submit"[^>]*>Send it our way<\/button>\s*<p class="contact-promise"><strong>We reply within one business day\.<\/strong><\/p>/);
  const lede = section.match(/<p class="contact-lede[^"]*">([\s\S]*?)<\/p>/)[1];
  assert.doesNotMatch(lede, /one business day/i, 'the promise is next to the form now; do not repeat it in the lede');
});

test('the new styles use the site color tokens only (no raw hex)', () => {
  const rules = (main.match(/\.contact-[a-z_-]+[^{]*\{[^}]*\}/g) || []).filter((r) => /^\.contact-(lede|aside|promise)/.test(r));
  assert.ok(rules.length >= 3, 'expected rules for contact-lede, contact-aside and contact-promise');
  for (const r of rules) assert.doesNotMatch(r, /#[0-9a-f]{3,8}\b/i, `raw hex color in: ${r}`);
});

test('"What happens when you hit send" is a single sentence', () => {
  assert.ok(section, 'section aria-label="What happens next" missing');
  assert.match(section, /<h2[^>]*>What happens when you hit send<\/h2>/);
  assert.doesNotMatch(section, /<ol\b|<li\b/, 'the three steps were folded into one sentence');
  const lede = (section.match(/<p class="contact-lede[^"]*">([\s\S]*?)<\/p>/) || [])[1];
  assert.ok(lede, 'p.contact-lede missing');
  const plain = lede.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
  assert.match(plain, /^[^.!?]+[.]$/, `must be exactly one sentence ending in a period: "${plain}"`);
  assert.match(plain, /^Gabriel or Eric, a real human and not a bot, reads it, writes back with next steps, and if the numbers work, tells you directly,/);
  assert.match(lede, /<em class="contact-lede__punch">suspense is not part of our process<\/em>/);
  assert.ok(plain.split(/\s+/).length <= 45, `keep it short enough that the punchline lands (${plain.split(/\s+/).length} words)`);
  assert.match(plain, /suspense is not part of our process/i);
});

test('the voice is dry: the nerd line, the aside and the form copy are in place', () => {
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
