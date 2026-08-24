'use strict';
const crypto = require('node:crypto');
const { checkHoneypot, sanitizeField, signIntakeToken } = require('./_shared/validate.js');
const { createUploadSession } = require('./_shared/graph-files.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');
const { verifyRecaptcha } = require('./_shared/recaptcha.js');

const ALLOWED_EXTS = ['pdf', 'xlsx', 'xls', 'doc', 'docx'];
const MAX_BYTES = 60 * 1024 * 1024;
const TOKEN_TTL_MS = 15 * 60 * 1000;

// ---------- Interim per-IP rate limit ----------
// This endpoint mints a Graph upload session (a real SharePoint write target)
// on every accepted call, and reCAPTCHA has been logged-but-NOT-enforced since
// the 2026-07-19 hotfix below — so until the widget is fixed there is nothing
// at all standing between a script and an unbounded run of upload sessions.
// This is the interim floor.
//
// Deliberately the same shape as the /api/chat limiter in
// netlify/edge-functions/chat.ts (in-memory Map of hit timestamps per IP,
// sliding window). Same caveat applies: the Map lives in one warm container,
// so the effective ceiling is per-container, not global. That is a genuine
// weakening versus the Blobs-backed limiter in _shared/broker-score-store.mjs
// — but that module is ESM importing @netlify/blobs, and this entry is
// CommonJS, which is exactly the bundling failure class that took production
// down twice on 2026-08-16 (see tests/functions/esm-cjs-bundling-contract.test.js).
// A per-container bound is worth far more than the zero bound we have now;
// promoting it to Blobs belongs with the V2/ESM conversion of this function.
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
function logIntake(fetchImpl, { name, company, email, phone, market, message, fileName }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(siteUrl, 'broker-submission-intake', { name, company, email, phone, market, message, 'file-name': fileName, 'occurred-at': new Date().toISOString() }, { fetchImpl });
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
    // Fail loudly, per this function's existing convention: console.error for
    // the deploy log plus a pipeline-failures row so it is visible without one.
    console.error('[broker-upload-session] rate limit exceeded', { ip, maxPerWindow, retryAfter: rl.retryAfter });
    await logFailure(fetchImpl, { errorCode: 'rate_limited', detail: `ip=${ip} max=${maxPerWindow}/10min` });
    return {
      statusCode: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfter) },
      body: JSON.stringify({ ok: false, error: 'rate_limited' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'invalid_json'); }

  if (checkHoneypot(body)) return ok({ ok: true }); // silent success, per chat-lead.js convention

  // TEMPORARILY NOT ENFORCED (2026-07-19, Gabriel-approved): the reCAPTCHA
  // Enterprise widget on for-brokers.html is rejecting real users with
  // "Invalid site key" for a reason not yet root-caused — every registration
  // detail (site key, domain, API enablement) checks out, but the client
  // widget still fails, which would make recaptchaToken empty for every
  // real submission and 403 the entire broker form. Still CALLING
  // verifyRecaptcha (and logging the result) so the integration stays
  // exercised and easy to re-enable — just not blocking on it yet.
  // TODO: restore `if (!recaptchaOk) return fail(403, 'recaptcha_failed');`
  // once the widget itself is confirmed working (via an actual screenshot,
  // not just DOM/JS state — see the false positives that shipped earlier
  // today from checking iframe presence instead of visible content).
  let recaptchaOk;
  try {
    recaptchaOk = await verifyRecaptcha(body.recaptchaToken, { fetchImpl });
  } catch (err) {
    console.error('[broker-upload-session] verifyRecaptcha threw', String(err));
    recaptchaOk = false;
  }
  if (!recaptchaOk) {
    console.error('[broker-upload-session] recaptcha check failed but is not enforced right now', { recaptchaOk });
  }

  const fileName = sanitizeField(body.fileName, 200);
  const fileSize = Number(body.fileSize);
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName) || [, ''])[1].toLowerCase();

  if (!fileName || !ALLOWED_EXTS.includes(ext)) return fail(422, 'file_type_rejected');
  if (!Number.isFinite(fileSize) || fileSize <= 0) return fail(422, 'invalid_file_size');
  if (fileSize > MAX_BYTES) return fail(413, 'file_too_large');

  const company = sanitizeField(body.company, 150) || 'Unknown Company';
  const dateStamp = new Date().toISOString().slice(0, 10);
  const folderPath = `Broker Submissions/${dateStamp}_${slugify(company)}_${crypto.randomBytes(4).toString('hex')}`;

  await logIntake(fetchImpl, {
    name: sanitizeField(body.name, 150),
    company,
    email: sanitizeField(body.email, 200),
    phone: sanitizeField(body.phone, 40),
    market: sanitizeField(body.market, 60),
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
