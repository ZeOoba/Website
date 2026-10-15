'use strict';
const { verifyNetlifyWebhookSignature, sanitizeField, sniffFileType, isAllowedUpload } = require('./_shared/validate.js');
const { alertInvalidSignature } = require('./_shared/signature-alert.js');
const { ensureFolder, uploadSmallFile } = require('./_shared/graph-files.js');
const { sendMail } = require('./_shared/graph-mail.js');
const { renderTenantEmail } = require('./_shared/email-template.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');

const WATCHED_FORM = 'commercial-lease-application';
const FILE_FIELDS = ['upload-credit-report', 'upload-drivers-license', 'upload-articles'];
const ALLOWED_EXTS = ['pdf', 'jpg', 'jpeg', 'png'];

function slugifyName(name) {
  return String(name || 'applicant').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'applicant';
}

// Durable, Graph-outage-independent alert channel (design doc §9) — every
// terminal failure below logs here BEFORE returning, so a broken Graph
// credential or a rejected file is never the silent failure this pipeline
// exists to replace.
function logFailure(fetchImpl, { errorCode, submissionId, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(
    siteUrl,
    'pipeline-failures',
    { 'source-function': 'tenant-application-processor', 'error-code': errorCode, 'submission-id': submissionId || '', detail: detail || '', 'occurred-at': new Date().toISOString() },
    { fetchImpl }
  );
}

exports.handler = async (event, { fetchImpl = fetch } = {}) => {
  const secret = process.env.NETLIFY_WEBHOOK_SECRET;
  const signature = (event.headers && (event.headers['x-webhook-signature'] || event.headers['X-Webhook-Signature'])) || '';
  if (!verifyNetlifyWebhookSignature(event.body, signature, secret)) {
    // Deploy-log only — NEVER a pipeline-failures Forms row. This webhook
    // receives every site form submission, pipeline-failures included, so a
    // row written here re-fires every webhook (exponential loop on a rotated
    // NETLIFY_WEBHOOK_SECRET) and lets any unauthenticated POST burn the Forms
    // quota. (The 400 malformed-JSON path below is likewise left unlogged.)
    console.error('[tenant-application-processor] invalid webhook signature (check NETLIFY_WEBHOOK_SECRET)');
    await alertInvalidSignature('tenant-application-processor', { fetchImpl });
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'invalid_signature' }) };
  }

  let submission;
  try {
    submission = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
  }

  // Envelope shape (form_name/data/id) confirmed against a real fired webhook
  // 2026-07-12 — matches Netlify's documented submission-created payload.
  const formName = submission.form_name;
  const data = submission.data || {};
  const submissionId = submission.id;

  if (formName !== WATCHED_FORM) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  const applicantName = sanitizeField(data['full-legal-name'], 100) || sanitizeField(data['applicant-email'], 100) || 'Unknown Applicant';
  const dateStamp = new Date().toISOString().slice(0, 10);
  const folderPath = `Tenant Applications/${dateStamp}_${slugifyName(applicantName)}_${String(submissionId).slice(0, 8)}`;

  const links = {};
  try {
    // Phase 1 — download and type-validate EVERY uploaded file before any
    // Graph write. A rejected file (or a failed download) must short-circuit
    // here so we never create an orphan OneDrive folder, never half-file a
    // submission, and never email a link to a rejected/broken document.
    const validated = [];
    for (const field of FILE_FIELDS) {
      // Netlify Forms serializes a file-upload field as {filename, type, size,
      // url} — confirmed against a real fired webhook via the Submissions API
      // — not the bare URL string the payload docs imply.
      const upload = data[field];
      if (!upload) continue;
      const fileUrl = upload.url;
      if (!fileUrl) throw new Error(`upload object missing url for field ${field}`);
      const fileRes = await fetchImpl(fileUrl);
      if (!fileRes.ok) throw new Error(`failed to fetch uploaded file for ${field} (${fileRes.status})`);
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const declaredName = upload.filename || fileUrl.split('/').pop() || `${field}.bin`;
      if (!isAllowedUpload(declaredName, buffer, ALLOWED_EXTS)) {
        await logFailure(fetchImpl, { errorCode: 'file_type_rejected', submissionId, detail: `field=${field} name=${declaredName}` });
        return { statusCode: 422, body: JSON.stringify({ ok: false, error: 'file_type_rejected', field }) };
      }
      const sniffed = sniffFileType(buffer);
      validated.push({ field, buffer, ext: sniffed.ext });
    }

    // Phase 2 — all files passed: create the dated folder and file them.
    const folder = await ensureFolder(folderPath, { fetchImpl });
    for (const { field, buffer, ext } of validated) {
      const uploaded = await uploadSmallFile(folder, `${field.replace('upload-', '')}.${ext}`, buffer, { fetchImpl });
      links[field] = uploaded.webUrl;
    }
  } catch (err) {
    console.error('[tenant-application-processor] filing failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'filing_failed', submissionId, detail: String(err) });
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'filing_failed' }) };
  }

  const sanitizedFields = {};
  for (const [key, value] of Object.entries(data)) {
    if (FILE_FIELDS.includes(key) || key === 'bot-field') continue;
    sanitizedFields[key] = sanitizeField(String(value), 500);
  }

  try {
    const { subject, html } = renderTenantEmail({ fields: sanitizedFields, links });
    await sendMail({ subject, html, to: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'] }, { fetchImpl });
  } catch (err) {
    console.error('[tenant-application-processor] email failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'email_failed', submissionId, detail: String(err) });
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'email_failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
