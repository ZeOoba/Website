'use strict';

// Returns { success, errorCodes } rather than a bare boolean so a caller can
// tell "a real user failed the challenge" apart from "our own config is
// broken" (wrong/missing secret, Google outage) — collapsing that to a
// boolean here is what made a 2026-09-07 secret misconfiguration
// indistinguishable from bot traffic in the caller's logs. See
// broker-upload-session.js's use of CONFIG_ERROR_CODES.
async function verifyRecaptcha(token, { fetchImpl = fetch, secret = process.env.RECAPTCHA_SECRET_KEY } = {}) {
  if (!secret) throw new Error('recaptcha: missing RECAPTCHA_SECRET_KEY');
  if (!token) return { success: false, errorCodes: ['missing-input-response'] };
  const params = new URLSearchParams({ secret, response: token });
  const res = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return { success: false, errorCodes: [`http-${res.status}`] };
  const json = await res.json();
  return { success: !!json.success, errorCodes: json['error-codes'] || null };
}

module.exports = { verifyRecaptcha };
