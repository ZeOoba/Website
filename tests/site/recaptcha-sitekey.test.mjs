// Guards the broker-form reCAPTCHA site key against transcription drift.
//
// The key was hand-transcribed into for-brokers.html on 2026-07-18 with a
// capital "I" where Google's admin console has a lowercase "l"
// (6LfxrIot… vs 6Lfxrlot…). Google rejected the mistyped key with
// "ERROR for site owner: Invalid site key" for seven weeks, and two
// client-library hotfixes chased the wrong layer. The value below was read
// character-by-character (charCode 108 = "l") from
// google.com/recaptcha/admin/site/760917745/settings on 2026-09-07 and
// verified to render a live checkbox on the oxfordra.net origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Site key (public by design — it ships in the HTML) for the "oxfordra.net"
// v2 Checkbox key in the reCAPTCHA admin console. Owner: ggoldberg@oxfordra.net.
const EXPECTED_SITE_KEY = '6LfxrlotAAAAAFL5oHPOqXC-aRgtGUWAZuDFfGmh';

test('for-brokers.html ships the exact reCAPTCHA site key registered in the admin console', () => {
  const html = readFileSync(path.join(ROOT, 'for-brokers.html'), 'utf8');
  const matches = [...html.matchAll(/id="recaptchaContainer"[^>]*data-sitekey="([^"]*)"/g)];
  assert.equal(matches.length, 1, 'expected exactly one #recaptchaContainer with a data-sitekey');
  const served = matches[0][1];
  assert.equal(
    served,
    EXPECTED_SITE_KEY,
    `data-sitekey drifted from the registered key (watch for I/l, O/0 transcription errors): got ${served}`,
  );
});

test('the registered site key contains a lowercase L, not a capital I, at position 5', () => {
  // Belt-and-braces: fails loudly if someone "corrects" the constant above
  // back to the visually identical wrong character.
  assert.equal(EXPECTED_SITE_KEY.charCodeAt(5), 108, 'position 5 must be lowercase "l" (charCode 108)');
});
