'use strict';
const crypto = require('node:crypto');
const { checkHoneypot, sanitizeField, signIntakeToken } = require('./_shared/validate.js');
const { checkRateLimit } = require('./_shared/rate-limit.js');
const { createUploadSession } = require('./_shared/graph-files.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');

const ALLOWED_EXTS = ['pdf', 'xlsx', 'xls', 'doc', 'docx'];
const MAX_BYTES = 60 * 1024 * 1024;
const TOKEN_TTL_MS = 15 * 60 * 1000;

function logFailure(fetchImpl, { errorCode, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(siteUrl, 'pipeline-failures', { 'source-function': 'broker-upload-session', 'error-code': errorCode, 'submission-id': '', detail: detail || '', 'occurred-at': new Date().toISOString() }, { fetchImpl });
}

function ok(body) { return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
function fail(statusCode, error) { return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error }) }; }

function slugify(value) {
  return String(value || 'submission').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'submission';
}

exports.handler = async (event, { fetchImpl = fetch, getClient } = {}) => {
  if (event.httpMethod !== 'POST') return fail(405, 'method_not_allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'invalid_json'); }

  const ip = (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For']) || 'unknown').split(',')[0].trim();
  let allowed;
  try {
    allowed = await checkRateLimit(ip, { getClient, limit: 10, windowMs: 60 * 60 * 1000 });
  } catch (err) {
    console.error('[broker-upload-session] checkRateLimit failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'rate_limit_check_failed', detail: String(err) });
    return fail(502, 'rate_limit_check_failed');
  }
  if (!allowed) return fail(429, 'rate_limited');

  if (checkHoneypot(body)) return ok({ ok: true }); // silent success, per chat-lead.js convention

  const fileName = sanitizeField(body.fileName, 200);
  const fileSize = Number(body.fileSize);
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName) || [, ''])[1].toLowerCase();

  if (!fileName || !ALLOWED_EXTS.includes(ext)) return fail(422, 'file_type_rejected');
  if (!Number.isFinite(fileSize) || fileSize <= 0) return fail(422, 'invalid_file_size');
  if (fileSize > MAX_BYTES) return fail(413, 'file_too_large');

  const company = sanitizeField(body.company, 150) || 'Unknown Company';
  const dateStamp = new Date().toISOString().slice(0, 10);
  const folderPath = `Broker Submissions/${dateStamp}_${slugify(company)}_${crypto.randomBytes(4).toString('hex')}`;

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
