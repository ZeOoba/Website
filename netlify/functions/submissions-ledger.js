'use strict';
/**
 * netlify/functions/submissions-ledger.js
 *
 * Netlify "Outgoing webhook" target (Site settings → Build & deploy → Post
 * processing → Deploy notifications → Form submission, ANY form) that appends
 * every form submission to the Website Submissions workbook (see
 * _shared/submissions-ledger.js and docs/submissions-ledger.md).
 *
 * Wired like contact-notify.js / owner-lead-notify.js / tenant-application-
 * processor.js, but unlike them it deliberately does NOT filter on form_name:
 * it is the all-forms ledger. Netlify keeps the raw submission regardless, so
 * a failed append is replayable from the dashboard.
 *
 * LOOP GUARD: failures are reported to the `pipeline-failures` form like every
 * other function — except when the submission being ledgered IS a
 * pipeline-failures row. That form fires this webhook too, so logging a
 * ledger failure for it would re-trigger this function and, during a Graph
 * outage, feed itself forever.
 */
const { verifyNetlifyWebhookSignature } = require('./_shared/validate.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');
const { appendSubmission } = require('./_shared/submissions-ledger.js');

const NO_RELOG_FORMS = new Set(['pipeline-failures']);

function logFailure(fetchImpl, { errorCode, submissionId, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(
    siteUrl,
    'pipeline-failures',
    { 'source-function': 'submissions-ledger', 'error-code': errorCode, 'submission-id': submissionId || '', detail: detail || '', 'occurred-at': new Date().toISOString() },
    { fetchImpl }
  );
}

exports.handler = async (event, { fetchImpl = fetch } = {}) => {
  const secret = process.env.NETLIFY_WEBHOOK_SECRET;
  const signature = (event.headers && (event.headers['x-webhook-signature'] || event.headers['X-Webhook-Signature'])) || '';
  if (!verifyNetlifyWebhookSignature(event.body, signature, secret)) {
    await logFailure(fetchImpl, { errorCode: 'invalid_signature', submissionId: '', detail: 'webhook signature verification failed' });
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

  try {
    const result = await appendSubmission({ formName, data, submissionId, fetchImpl });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    console.error('[submissions-ledger] append failed', formName, String(err));
    if (!NO_RELOG_FORMS.has(formName)) {
      await logFailure(fetchImpl, { errorCode: 'ledger_append_failed', submissionId, detail: `${formName}: ${String(err)}`.slice(0, 500) });
    }
    // Non-2xx so Netlify retries the webhook delivery.
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'ledger_append_failed' }) };
  }
};
