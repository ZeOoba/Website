'use strict';
/**
 * netlify/functions/checklist-notify.js
 *
 * Netlify `submission-created` outgoing-webhook target for the
 * `checklist-download` form on /resources/industrial-building-sale-document-checklist.
 * Wired like owner-lead-notify.js: an "Outgoing webhook" deploy notification that
 * receives a POST for EVERY form on the site, so the form_name gate below is not
 * optional.
 *
 * Recipient is Gabriel only. A checklist download is a low-intent top-of-funnel
 * lead (unlike an owner intake or a broker deal, which notify both principals), so
 * a per-download email to both would be noise; the lead is also stored in Netlify Forms.
 */
const { verifyNetlifyWebhookSignature, sanitizeField } = require('./_shared/validate.js');
const { sendMail } = require('./_shared/graph-mail.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');

const WATCHED_FORM = 'checklist-download';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderChecklistEmail({ fields }) {
  const name = (fields && fields.name) || 'Unknown';
  const email = (fields && fields.email) || '';
  return {
    subject: `Checklist Requested — ${name}`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#F5F3EF;">
<div style="max-width:640px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;">
  <div style="background:#1B2A4A;padding:24px 32px;">
    <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:400;">Sale-Ready Checklist Requested</h1>
  </div>
  <div style="background:#ffffff;padding:24px 32px;font-family:Arial,sans-serif;font-size:14px;color:#2D2D2D;line-height:1.6;">
    <p style="margin:0 0 8px;"><strong>${escapeHtml(name)}</strong></p>
    <p style="margin:0;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
  </div>
  <div style="padding:16px 32px;font-family:Arial,sans-serif;font-size:11px;color:#596B7D;">Oxford Realty Advisors — automated submission notice (document checklist download).</div>
</div></body></html>`,
  };
}

function logFailure(fetchImpl, { errorCode, submissionId, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(
    siteUrl,
    'pipeline-failures',
    { 'source-function': 'checklist-notify', 'error-code': errorCode, 'submission-id': submissionId || '', detail: detail || '', 'occurred-at': new Date().toISOString() },
    { fetchImpl }
  );
}

exports.handler = async (event, { fetchImpl = fetch } = {}) => {
  const secret = process.env.NETLIFY_WEBHOOK_SECRET;
  const signature = (event.headers && (event.headers['x-webhook-signature'] || event.headers['X-Webhook-Signature'])) || '';
  if (!verifyNetlifyWebhookSignature(event.body, signature, secret)) {
    // Deploy-log only — NEVER a pipeline-failures Forms row (it would re-fire
    // every webhook: exponential loop + unauthenticated Forms-quota burn).
    console.error('[checklist-notify] invalid webhook signature (check NETLIFY_WEBHOOK_SECRET)');
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'invalid_signature' }) };
  }

  let submission;
  try {
    submission = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
  }

  if (submission.form_name !== WATCHED_FORM) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  const data = submission.data || {};
  const fields = { name: sanitizeField(String(data.name || ''), 150), email: sanitizeField(String(data.email || ''), 200) };

  try {
    const { subject, html } = renderChecklistEmail({ fields });
    await sendMail({ subject, html, to: ['ggoldberg@oxfordra.net'] }, { fetchImpl });
  } catch (err) {
    console.error('[checklist-notify] email failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'email_failed', submissionId: submission.id, detail: String(err) });
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'email_failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
