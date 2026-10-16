'use strict';
// V1-side client for the rejected-webhook-signature alert.
//
// A rotated or missing NETLIFY_WEBHOOK_SECRET makes every submission-created webhook 401, silently dropping
// leads. The original fix wrote a pipeline-failures Forms row, which re-fired every webhook (exponential
// loop) and let unauthenticated POSTs burn the Forms quota. The replacement here must stay loud WITHOUT
// becoming a new abuse path, and an adversarial review (2026-10-15) showed the first version was one:
//   - it sent Graph mail directly from the four public webhook functions with a per-instance in-memory
//     throttle, so an unauthenticated caller could cause roughly 4 x concurrency mails per hour from the SAME
//     mailbox that sends the real lead notifications (Graph throttling would then drop real leads);
//   - any bare GET or scanner counted as a "rotation", so it also cried wolf;
//   - the send was awaited with no timeout.
//
// So this module no longer sends mail. It decides WHETHER to ask the V2 `signature-alert` function to, and
// does so with a short-lived signed token. The global once-per-hour guard (a create-only Blobs key) lives in
// that V2 function because Blobs auto-provisioning does not cover V1 functions like these. This client:
//   - ignores requests whose signature header is not even shaped like a JWS (scanners, crawlers, junk);
//   - treats an UNSET NETLIFY_WEBHOOK_SECRET as high confidence;
//   - keeps a short per-instance cooldown so a flood does not hammer the V2 function;
//   - is bounded in time and never throws, so the webhook still returns its 401.
// It never touches Netlify Forms.
const { signIntakeToken } = require('./validate.js');

const COOLDOWN_MS = 60 * 1000;
const TOKEN_TTL_MS = 60 * 1000;
// Long enough for the V2 function to claim the hour AND send (its claim <= 1.5 s + mail <= 3 s = 4.5 s), so the
// invocation is not abandoned between claiming the hour and sending. This only delays the 401 for the one request
// per instance per COOLDOWN_MS that actually calls out; every other bad request returns immediately.
const CALL_TIMEOUT_MS = 5000;
const JWS_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

let lastCallAt = 0;

function looksLikeSignature(value) {
  return typeof value === 'string' && JWS_SHAPE.test(value);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Returns one of: 'sent' | 'ignored' | 'cooldown' | 'no_secret' | 'failed'. Never throws.
 *   signatureHeader: the raw x-webhook-signature header value (may be empty/missing)
 *   secretSet:       whether NETLIFY_WEBHOOK_SECRET is configured (false = high-confidence misconfiguration)
 */
async function alertInvalidSignature(fnName, { signatureHeader, secretSet = true, fetchImpl = fetch, now = () => Date.now(), timeoutMs = CALL_TIMEOUT_MS } = {}) {
  try {
    if (secretSet && !looksLikeSignature(signatureHeader)) return 'ignored';

    const t = now();
    if (lastCallAt && t - lastCallAt < COOLDOWN_MS) return 'cooldown';
    lastCallAt = t; // claim before awaiting so concurrent requests on this instance make one call

    const secret = process.env.INTAKE_TOKEN_SECRET;
    if (!secret) {
      console.error(`[${fnName}] signature alert skipped: INTAKE_TOKEN_SECRET is not set`);
      return 'no_secret';
    }
    const token = signIntakeToken({ type: 'sig-alert', fn: fnName, exp: Date.now() + TOKEN_TTL_MS }, secret);
    const base = process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://oxfordra.net';
    const res = await withTimeout(
      fetchImpl(`${base}/.netlify/functions/signature-alert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
      timeoutMs,
    );
    return res && res.ok ? 'sent' : 'failed';
  } catch (e) {
    console.error(`[${fnName}] signature alert request failed:`, e instanceof Error ? e.message : String(e));
    return 'failed';
  }
}

function _resetForTests() {
  lastCallAt = 0;
}

module.exports = { alertInvalidSignature, looksLikeSignature, COOLDOWN_MS, _resetForTests };
