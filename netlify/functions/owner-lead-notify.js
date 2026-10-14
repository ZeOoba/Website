'use strict';
/**
 * netlify/functions/owner-lead-notify.js
 *
 * Netlify `submission-created` outgoing-webhook target for the
 * `owner-submission-intake` form on /sell-your-building (see
 * sell-your-building.html). Wired the same way as
 * tenant-application-processor.js — as a Netlify "Outgoing webhook" deploy
 * notification (Site settings → Build & deploy → Post processing → Deploy
 * notifications), NOT the bare `submission-created.js` filename convention.
 * That means this endpoint receives a POST for EVERY form submitted
 * anywhere on the site (contact, chat-lead, broker-submission-intake,
 * broker-network-ledger, pipeline-failures, commercial-lease-application,
 * owner-submission-intake, etc.) — the form_name gate below is therefore
 * not optional: without it, this function would double- (or n-tuple-)
 * notify on every unrelated submission site-wide.
 */
const { verifyNetlifyWebhookSignature, sanitizeField } = require('./_shared/validate.js');
const { alertInvalidSignature } = require('./_shared/signature-alert.js');
const { sendMail } = require('./_shared/graph-mail.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');

const WATCHED_FORM = 'owner-submission-intake';

const LABELS = {
  'property-address': 'Property Address',
  'building-size-sf': 'Approximate Building Size (SF)',
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  'reason-for-selling': 'Reason for Selling',
  timeline: 'Timeline',
  'occupancy-status': 'Occupancy Status',
  'asking-price-expectation': 'Asking Price Expectation',
  'referral-source': 'How They Heard About Us',
  'tcpa-consent': 'TCPA/SMS Consent',
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
    .map((k) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#596B7D;white-space:nowrap;">${escapeHtml(LABELS[k] || k)}</td><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#2D2D2D;">${escapeHtml(fields[k])}</td></tr>`)
    .join('');
}

function renderOwnerEmail({ fields }) {
  const address = (fields && fields['property-address']) || 'Unspecified Property';
  const name = (fields && fields.name) || 'Unknown Owner';
  return {
    subject: `New Owner Lead — ${address} (${name})`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#F5F3EF;">
<div style="max-width:640px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;">
  <div style="background:#1B2A4A;padding:24px 32px;">
    <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:400;">Owner Lead — ${escapeHtml(address)}</h1>
  </div>
  <div style="background:#ffffff;padding:24px 32px;">
    <table style="width:100%;border-collapse:collapse;">${renderRows(fields || {})}</table>
  </div>
  <div style="padding:16px 32px;font-family:Arial,sans-serif;font-size:11px;color:#596B7D;">Oxford Realty Advisors — automated submission notice (sell-your-building.html).</div>
</div></body></html>`,
  };
}

function logFailure(fetchImpl, { errorCode, submissionId, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(
    siteUrl,
    'pipeline-failures',
    { 'source-function': 'owner-lead-notify', 'error-code': errorCode, 'submission-id': submissionId || '', detail: detail || '', 'occurred-at': new Date().toISOString() },
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
    console.error('[owner-lead-notify] invalid webhook signature (check NETLIFY_WEBHOOK_SECRET)');
    await alertInvalidSignature('owner-lead-notify', { fetchImpl });
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'invalid_signature' }) };
  }

  let submission;
  try {
    submission = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
  }

  // Envelope shape (form_name/data/id) matches the documented Netlify
  // submission-created payload, confirmed in tenant-application-processor.js.
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
    if (key === 'bot-field' || key === 'form-name') continue;
    fields[key] = sanitizeField(String(value), 500);
  }

  try {
    const { subject, html } = renderOwnerEmail({ fields });
    await sendMail({ subject, html, to: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'] }, { fetchImpl });
  } catch (err) {
    console.error('[owner-lead-notify] email failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'email_failed', submissionId, detail: String(err) });
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'email_failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
