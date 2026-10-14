'use strict';
/**
 * netlify/functions/contact-notify.js
 *
 * Netlify `submission-created` outgoing-webhook target for the `contact` form
 * on /contact (see contact.html). Wired the same way as owner-lead-notify.js
 * and tenant-application-processor.js — as a Netlify "Outgoing webhook" deploy
 * notification (Site settings → Build & deploy → Post processing → Deploy
 * notifications), NOT the bare `submission-created.js` filename convention.
 * That means this endpoint receives a POST for EVERY form submitted anywhere
 * on the site, so the form_name gate below is not optional: without it, this
 * function would notify on every unrelated submission site-wide.
 *
 * Before this function existed, a contact submission depended entirely on
 * Netlify's dashboard-configured native email notification: invisible to the
 * repo, untested, and with no failure ledger if it silently stopped firing.
 */
const { verifyNetlifyWebhookSignature, sanitizeField } = require('./_shared/validate.js');
const { sendMail } = require('./_shared/graph-mail.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');

const WATCHED_FORM = 'contact';

const LABELS = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  subject: 'Subject',
  'referral-source': 'How They Heard About Us',
  message: 'Message',
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRows(fields) {
  return Object.keys(fields)
    .filter((k) => fields[k] !== '' && fields[k] != null)
    .map((k) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#596B7D;white-space:nowrap;vertical-align:top;">${escapeHtml(LABELS[k] || k)}</td><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#2D2D2D;">${escapeHtml(fields[k])}</td></tr>`)
    .join('');
}

function renderContactEmail({ fields }) {
  const subject = (fields && fields.subject) || 'General';
  const name = (fields && fields.name) || 'Unknown Sender';
  return {
    subject: `New Contact Message — ${subject} (${name})`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#F5F3EF;">
<div style="max-width:640px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;">
  <div style="background:#1B2A4A;padding:24px 32px;">
    <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:400;">Contact Message — ${escapeHtml(subject)}</h1>
  </div>
  <div style="background:#ffffff;padding:24px 32px;">
    <table style="width:100%;border-collapse:collapse;">${renderRows(fields || {})}</table>
  </div>
  <div style="padding:16px 32px;font-family:Arial,sans-serif;font-size:11px;color:#596B7D;">Oxford Realty Advisors — automated submission notice (contact.html).</div>
</div></body></html>`,
  };
}

function logFailure(fetchImpl, { errorCode, submissionId, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(
    siteUrl,
    'pipeline-failures',
    { 'source-function': 'contact-notify', 'error-code': errorCode, 'submission-id': submissionId || '', detail: detail || '', 'occurred-at': new Date().toISOString() },
    { fetchImpl }
  );
}

exports.handler = async (event, { fetchImpl = fetch } = {}) => {
  const secret = process.env.NETLIFY_WEBHOOK_SECRET;
  const signature = (event.headers && (event.headers['x-webhook-signature'] || event.headers['X-Webhook-Signature'])) || '';
  if (!verifyNetlifyWebhookSignature(event.body, signature, secret)) {
    // Deploy-log only — NEVER a pipeline-failures Forms row. This webhook
    // receives every site form submission, pipeline-failures included, so a
    // row written here re-fires this and every sibling webhook (exponential
    // loop on a rotated/missing secret) and lets any unauthenticated POST
    // burn the Forms quota. A rotated secret is surfaced via function logs.
    console.error('[contact-notify] invalid webhook signature (check NETLIFY_WEBHOOK_SECRET)');
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'invalid_signature' }) };
  }

  let submission;
  try {
    submission = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
  }

  const formName = submission.form_name;
  const data = submission.data || {};
  const submissionId = submission.id;

  // Critical: this webhook fires for EVERY form on the site. Anything that
  // isn't our form must no-op with a plain 200 — never send an email.
  if (formName !== WATCHED_FORM) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'bot-field' || key === 'form-name' || key === 'g-recaptcha-response') continue;
    // The message is free text and can legitimately run long; every other
    // field is short structured input.
    fields[key] = sanitizeField(String(value), key === 'message' ? 2000 : 500);
  }

  try {
    const { subject, html } = renderContactEmail({ fields });
    await sendMail({ subject, html, to: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'] }, { fetchImpl });
  } catch (err) {
    console.error('[contact-notify] email failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'email_failed', submissionId, detail: String(err) });
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'email_failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
