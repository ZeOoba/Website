'use strict';
/**
 * signature-alert.js (V1 side): decides WHETHER to ask the V2 signature-alert function to send the alert, and
 * does so with a short-lived signed token. It never sends mail itself, never touches Netlify Forms, never
 * throws, and is bounded in time.
 *
 * Why it is a thin client now: the first version sent Graph mail directly with a per-instance in-memory
 * throttle. Adversarial review (2026-10-15) showed an unauthenticated caller could cause ~4 x concurrency
 * mails per hour from the lead mailbox (and starve real lead mail via Graph throttling). The global,
 * durable once-per-hour guard has to live in a V2 function (Blobs auto-provisioning does not cover V1), so
 * this module only calls it, and only when the request looks like a plausible secret rotation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { alertInvalidSignature, COOLDOWN_MS, looksLikeSignature, _resetForTests } = require('../../../netlify/functions/_shared/signature-alert.js');
const { verifyIntakeToken } = require('../../../netlify/functions/_shared/validate.js');

const ENV = { INTAKE_TOKEN_SECRET: 'intake-secret', URL: 'https://oxfordra.net', DEPLOY_PRIME_URL: '' };
function withEnv(fn, over = {}) {
  const vars = { ...ENV, ...over };
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  _resetForTests();
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}
const recorder = (res = { ok: true, status: 200 }) => {
  const calls = [];
  return { calls, fetchImpl: async (url, opts = {}) => { calls.push({ url: String(url), opts }); return res; } };
};
const JWS = 'aaa.bbb.ccc'; // JWS-shaped (what a real or forged Netlify signature header looks like)

test('looksLikeSignature: only a three-part dotted token counts; empty, missing and junk do not', () => {
  assert.equal(looksLikeSignature(JWS), true);
  assert.equal(looksLikeSignature('eyJhbGciOi.eyJpc3MiOiJuZXRsaWZ5In0.sig_-9'), true);
  for (const bad of ['', undefined, null, 'x', 'a.b', 'a.b.c.d', 'a..c', 'a b.c.d', 123]) assert.equal(looksLikeSignature(bad), false, String(bad));
});

test('a JWS-shaped bad signature makes exactly one signed call to the V2 signature-alert function and nothing else', () => withEnv(async () => {
  const { fetchImpl, calls } = recorder();
  assert.equal(await alertInvalidSignature('contact-notify', { signatureHeader: JWS, secretSet: true, fetchImpl }), 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oxfordra.net/.netlify/functions/signature-alert');
  assert.equal(calls[0].opts.method, 'POST');
  const { token } = JSON.parse(calls[0].opts.body);
  const claims = verifyIntakeToken(token, 'intake-secret', 'sig-alert');
  assert.ok(claims, 'the token must verify with the intake secret and type sig-alert');
  assert.equal(claims.fn, 'contact-notify');
  assert.ok(claims.exp > Date.now() && claims.exp <= Date.now() + 120_000, 'token must be short-lived');
}));

test('a missing or malformed signature header is silent: zero network calls (a scanner is not a rotation)', () => withEnv(async () => {
  for (const signatureHeader of ['', undefined, 'garbage', 'a.b']) {
    const { fetchImpl, calls } = recorder();
    assert.equal(await alertInvalidSignature('contact-notify', { signatureHeader, secretSet: true, fetchImpl }), 'ignored');
    assert.deepEqual(calls, []);
  }
}));

test('an unset NETLIFY_WEBHOOK_SECRET is high confidence and alerts even without a header', () => withEnv(async () => {
  const { fetchImpl, calls } = recorder();
  assert.equal(await alertInvalidSignature('owner-lead-notify', { signatureHeader: '', secretSet: false, fetchImpl }), 'sent');
  assert.equal(calls.length, 1);
}));

test('a per-instance cooldown stops a flood from hammering the V2 function, then re-arms', () => withEnv(async () => {
  const { fetchImpl, calls } = recorder();
  let t = 5_000_000; const now = () => t;
  const go = () => alertInvalidSignature('checklist-notify', { signatureHeader: JWS, secretSet: true, fetchImpl, now });
  assert.equal(await go(), 'sent');
  assert.equal(await go(), 'cooldown');
  t += COOLDOWN_MS - 1;
  assert.equal(await go(), 'cooldown');
  t += 2;
  assert.equal(await go(), 'sent');
  assert.equal(calls.length, 2);
}));

test('concurrent bad signatures on ONE instance make exactly one call (the claim happens before the await)', () => withEnv(async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push(url); await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 200 }; };
  const results = await Promise.all(Array.from({ length: 10 }, () => alertInvalidSignature('contact-notify', { signatureHeader: JWS, secretSet: true, fetchImpl })));
  assert.equal(calls.length, 1, `made ${calls.length} calls`);
  assert.equal(results.filter((r) => r === 'sent').length, 1);
  assert.equal(results.filter((r) => r === 'cooldown').length, 9);
}));

test('without INTAKE_TOKEN_SECRET it cannot sign: no network call, no throw', () => withEnv(async () => {
  const { fetchImpl, calls } = recorder();
  assert.equal(await alertInvalidSignature('contact-notify', { signatureHeader: JWS, secretSet: true, fetchImpl }), 'no_secret');
  assert.deepEqual(calls, []);
}, { INTAKE_TOKEN_SECRET: undefined }));

test('never throws: a rejecting fetch, a non-ok answer and a hung fetch all return a status', () => withEnv(async () => {
  const boom = async () => { throw new Error('network down'); };
  assert.equal(await alertInvalidSignature('a', { signatureHeader: JWS, secretSet: true, fetchImpl: boom }), 'failed');
  _resetForTests();
  assert.equal(await alertInvalidSignature('a', { signatureHeader: JWS, secretSet: true, fetchImpl: recorder({ ok: false, status: 500 }).fetchImpl }), 'failed');
}));

test('a hung V2 call is cut off by the timeout so the 401 is not held hostage', () => withEnv(async () => {
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  assert.equal(await alertInvalidSignature('a', { signatureHeader: JWS, secretSet: true, fetchImpl: hang, timeoutMs: 40 }), 'failed');
  assert.ok(Date.now() - t0 < 2000, 'must return soon after the 40 ms bound');
}));

test('the base URL prefers DEPLOY_PRIME_URL (so a preview alerts through its own function) and falls back to URL', () => withEnv(async () => {
  const a = recorder();
  await alertInvalidSignature('a', { signatureHeader: JWS, secretSet: true, fetchImpl: a.fetchImpl });
  assert.equal(a.calls[0].url, 'https://preview--site.netlify.app/.netlify/functions/signature-alert');
}, { DEPLOY_PRIME_URL: 'https://preview--site.netlify.app' }));
