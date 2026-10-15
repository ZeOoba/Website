'use strict';
const crypto = require('node:crypto');
const { checkHoneypot, sanitizeField, signIntakeToken } = require('./_shared/validate.js');
const { createUploadSession } = require('./_shared/graph-files.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');
const { verifyRecaptcha } = require('./_shared/recaptcha.js');

const ALLOWED_EXTS = ['pdf', 'xlsx', 'xls', 'doc', 'docx'];
const MAX_BYTES = 60 * 1024 * 1024;
const TOKEN_TTL_MS = 15 * 60 * 1000;
// Google siteverify error-codes that mean OUR config is broken, not that a
// user failed/skipped the challenge — see the reCAPTCHA block below.
// 'threw' is the handler's own code for verifyRecaptcha throwing (RECAPTCHA_SECRET_KEY
// unset is the common cause) — config-class by definition, so it must reach
// pipeline-failures like Google's own secret errors do.
const CONFIG_ERROR_CODES = new Set(['invalid-input-secret', 'missing-input-secret', 'bad-request', 'threw']);

// ---------- Interim per-IP rate limit ----------
// This endpoint mints a Graph upload session (a real SharePoint write target)
// on every accepted call. reCAPTCHA enforcement is back on below (2026-09-07),
// but this floor stays as defense in depth rather than the sole abuse gate —
// it was built for the 2026-07-19-to-2026-09-07 window when reCAPTCHA was
// logged-but-not-enforced, and removing it now would trade a second, cheap
// layer for no benefit.
//
// Deliberately the same shape as the /api/chat limiter in
// netlify/edge-functions/chat.ts (in-memory Map of hit timestamps per IP,
// sliding window). Same caveat applies: the Map lives in one warm container,
// so the effective ceiling is per-container, not global. That is a genuine
// weakening versus the Blobs-backed limiter in _shared/broker-score-store.mjs
// — but that module is ESM importing @netlify/blobs, and this entry is
// CommonJS, which is exactly the bundling failure class that took production
// down twice on 2026-08-16 (see tests/functions/esm-cjs-bundling-contract.test.js).
// A per-container bound is still worth more than a global bound that never
// ships; promoting it to Blobs belongs with the V2/ESM conversion of this
// function.
const RATE_WINDOW_MS = 10 * 60 * 1000;   // 10 minutes
const RATE_DEFAULT = 10;                 // sessions per IP per window
const rateBuckets = new Map();

function clientIp(event) {
  const headers = event.headers || {};
  return headers['x-nf-client-connection-ip']
      || String(headers['x-forwarded-for'] || '').split(',')[0].trim()
      || 'unknown';
}

function rateLimit(ip, max) {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= max) {
    rateBuckets.set(ip, bucket);
    return { ok: false, retryAfter: Math.ceil((RATE_WINDOW_MS - (now - bucket[0])) / 1000) };
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  return { ok: true };
}

// Test-only hook: the bucket map is module-level, so without this every test in
// a file would share (and silently exhaust) one another's budget.
function __resetRateLimit() { rateBuckets.clear(); }

function logFailure(fetchImpl, { errorCode, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(siteUrl, 'pipeline-failures', { 'source-function': 'broker-upload-session', 'error-code': errorCode, 'submission-id': '', detail: detail || '', 'occurred-at': new Date().toISOString() }, { fetchImpl });
}

// Logged BEFORE the Graph upload session is minted — a completed
// broker-network-ledger row only exists once broker-finalize.js runs, so
// without this, a dropped connection or a Graph outage between here and
// finalize loses the broker's contact/deal context entirely, leaving (at
// best) an orphaned, unlabeled file in SharePoint.
function logIntake(fetchImpl, { name, company, email, phone, market, referralSource, message, fileName }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(siteUrl, 'broker-submission-intake', { name, company, email, phone, market, 'referral-source': referralSource || '', message, 'file-name': fileName, 'occurred-at': new Date().toISOString() }, { fetchImpl });
}

function ok(body) { return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
function fail(statusCode, error) { return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error }) }; }

function slugify(value) {
  return String(value || 'submission').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'submission';
}

exports.handler = async (event, { fetchImpl = fetch } = {}) => {
  if (event.httpMethod !== 'POST') return fail(405, 'method_not_allowed');

  // Rate limit first, so a flood cannot reach JSON parsing, Graph, or the
  // Netlify Forms writes below.
  const ip = clientIp(event);
  const maxPerWindow = parseInt(process.env.BROKER_UPLOAD_RATE_LIMIT_PER_10MIN || String(RATE_DEFAULT), 10) || RATE_DEFAULT;
  const rl = rateLimit(ip, maxPerWindow);
  if (!rl.ok) {
    // Deploy-log only — NEVER a pipeline-failures Forms row. The limiter's job
    // is to protect the Forms quota; a row per rejected request (each firing
    // every submission-created webhook) would let a flood burn it instead.
    console.error('[broker-upload-session] rate limit exceeded', { ip, maxPerWindow, retryAfter: rl.retryAfter });
    return {
      statusCode: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfter) },
      body: JSON.stringify({ ok: false, error: 'rate_limited' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'invalid_json'); }

  if (checkHoneypot(body)) return ok({ ok: true }); // silent success, per chat-lead.js convention

  // These two checks are pure/local (no network, no side effect) and are
  // deliberately ordered BEFORE the reCAPTCHA gate below: a broker who ticks
  // the box but picks the wrong file type shouldn't burn a single-use
  // reCAPTCHA token and have to re-solve just to learn that. Keep anything
  // with a real side effect (logIntake, Graph, reCAPTCHA's own network call)
  // after the gate.
  const fileName = sanitizeField(body.fileName, 200);
  const fileSize = Number(body.fileSize);
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName) || [, ''])[1].toLowerCase();

  if (!fileName || !ALLOWED_EXTS.includes(ext)) return fail(422, 'file_type_rejected');
  if (!Number.isFinite(fileSize) || fileSize <= 0) return fail(422, 'invalid_file_size');
  if (fileSize > MAX_BYTES) return fail(413, 'file_too_large');

  // RE-ENFORCED 2026-09-07 (Gabriel-approved). The original "Invalid site
  // key" failure (disabled 2026-07-19) was a client-side typo: the site key
  // in for-brokers.html had a capital I where the registered key has a
  // lowercase l, fixed in PR #75 and confirmed live — the widget renders and
  // the checkbox solves normally now. RECAPTCHA_SECRET_KEY was also reset the
  // same day: Netlify masks any env var flagged `is_secret` in every
  // CLI/API/`dev:exec` read path by substituting its own display placeholder
  // rather than refusing, which made the prior value impossible to inspect
  // and easy to mistake for something it wasn't. It was reset outright to
  // the value in the reCAPTCHA admin console, verified character-by-character.
  //
  // verifyRecaptcha returns { success, errorCodes } rather than a boolean so
  // a config problem (bad secret, Google outage) is distinguishable in logs
  // from an ordinary failed/skipped challenge — see CONFIG_ERROR_CODES below.
  let recaptchaResult;
  try {
    recaptchaResult = await verifyRecaptcha(body.recaptchaToken, { fetchImpl });
  } catch (err) {
    console.error('[broker-upload-session] verifyRecaptcha threw', String(err));
    recaptchaResult = { success: false, errorCodes: ['threw'] };
  }
  if (!recaptchaResult.success) {
    const errorCodes = recaptchaResult.errorCodes || [];
    console.error('[broker-upload-session] recaptcha check failed', { errorCodes });
    // A real user's failed/skipped challenge is routine and not worth a
    // pipeline-failures row (that channel would drown in bot noise). A
    // secret/config-class error is a production incident and must be
    // visible somewhere other than a function log nobody is tailing.
    if (errorCodes.some((c) => CONFIG_ERROR_CODES.has(c) || c.startsWith('http-'))) {
      await logFailure(fetchImpl, { errorCode: 'recaptcha_config_error', detail: errorCodes.join(',') });
    }
    return fail(403, 'recaptcha_failed');
  }

  const company = sanitizeField(body.company, 150) || 'Unknown Company';
  const dateStamp = new Date().toISOString().slice(0, 10);
  const folderPath = `Broker Submissions/${dateStamp}_${slugify(company)}_${crypto.randomBytes(4).toString('hex')}`;

  await logIntake(fetchImpl, {
    name: sanitizeField(body.name, 150),
    company,
    email: sanitizeField(body.email, 200),
    phone: sanitizeField(body.phone, 40),
    market: sanitizeField(body.market, 60),
    referralSource: sanitizeField(body.referralSource, 60),
    message: sanitizeField(body.message, 2000),
    fileName,
  });

  let session;
  try {
    session = await createUploadSession(folderPath, fileName, fileSize, { fetchImpl });
  } catch (err) {
    console.error('[broker-upload-session] createUploadSession failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'session_failed', detail: String(err) });
    return fail(502, 'session_failed');
  }

  const intakeToken = signIntakeToken({ type: 'upload', path: session.path, size: fileSize, exp: Date.now() + TOKEN_TTL_MS }, process.env.INTAKE_TOKEN_SECRET);
  return ok({ ok: true, uploadUrl: session.uploadUrl, intakeToken });
};

exports.__resetRateLimit = __resetRateLimit;
exports.RATE_DEFAULT = RATE_DEFAULT;
