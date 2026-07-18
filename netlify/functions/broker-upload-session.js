'use strict';
const crypto = require('node:crypto');
const { checkHoneypot, sanitizeField, signIntakeToken } = require('./_shared/validate.js');
const { createUploadSession } = require('./_shared/graph-files.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');
const { verifyRecaptcha } = require('./_shared/recaptcha.js');

const ALLOWED_EXTS = ['pdf', 'xlsx', 'xls', 'doc', 'docx'];
const MAX_BYTES = 60 * 1024 * 1024;
const TOKEN_TTL_MS = 15 * 60 * 1000;

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

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'invalid_json'); }

  if (checkHoneypot(body)) return ok({ ok: true }); // silent success, per chat-lead.js convention

  let recaptchaOk;
  try {
    recaptchaOk = await verifyRecaptcha(body.recaptchaToken, { fetchImpl });
  } catch (err) {
    // Fail closed: a thrown error (missing RECAPTCHA_SECRET_KEY, or a
    // network-level failure calling Google's siteverify endpoint) is
    // ambiguous, not a confirmed pass — treat it the same as an explicit
    // verification failure rather than 500ing this public entry point.
    console.error('[broker-upload-session] verifyRecaptcha threw', String(err));
    recaptchaOk = false;
  }
  if (!recaptchaOk) return fail(403, 'recaptcha_failed');

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

  const intakeToken = signIntakeToken({ path: session.path, size: fileSize, exp: Date.now() + TOKEN_TTL_MS }, process.env.INTAKE_TOKEN_SECRET);
  return ok({ ok: true, uploadUrl: session.uploadUrl, intakeToken });
};
