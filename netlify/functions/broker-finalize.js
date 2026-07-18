'use strict';
const crypto = require('node:crypto');
const { verifyIntakeToken, sanitizeField } = require('./_shared/validate.js');
const { getItemByPath } = require('./_shared/graph-files.js');
const { sendMail } = require('./_shared/graph-mail.js');
const { renderBrokerEmail } = require('./_shared/email-template.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');

function ok(body) { return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
function fail(statusCode, error) { return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error }) }; }

function logFailure(fetchImpl, { errorCode, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(siteUrl, 'pipeline-failures', { 'source-function': 'broker-finalize', 'error-code': errorCode, 'submission-id': '', detail: detail || '', 'occurred-at': new Date().toISOString() }, { fetchImpl });
}

exports.handler = async (event, { fetchImpl = fetch } = {}) => {
  if (event.httpMethod !== 'POST') return fail(405, 'method_not_allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'invalid_json'); }

  const claims = verifyIntakeToken(body.intakeToken, process.env.INTAKE_TOKEN_SECRET);
  if (!claims) return fail(401, 'invalid_intake_token');

  let item;
  try {
    item = await getItemByPath(claims.path, { fetchImpl });
  } catch (err) {
    console.error('[broker-finalize] getItemByPath failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'lookup_failed', detail: String(err) });
    return fail(502, 'lookup_failed');
  }
  if (!item) {
    await logFailure(fetchImpl, { errorCode: 'upload_not_found', detail: claims.path });
    return fail(409, 'upload_not_found');
  }
  if (typeof item.size === 'number' && item.size !== claims.size) {
    await logFailure(fetchImpl, { errorCode: 'size_mismatch', detail: `${claims.path} expected=${claims.size} actual=${item.size}` });
    return fail(409, 'size_mismatch');
  }

  const fields = {
    name: sanitizeField(body.name, 150),
    company: sanitizeField(body.company, 150),
    email: sanitizeField(body.email, 200),
    phone: sanitizeField(body.phone, 40),
    market: sanitizeField(body.market, 60),
    message: sanitizeField(body.message, 2000),
  };

  const siteUrl = process.env.URL || 'https://oxfordra.net';
  await forwardToNetlifyForm(siteUrl, 'broker-network-ledger', { ...fields, 'document-path': claims.path }, { fetchImpl });

  try {
    const { subject, html } = renderBrokerEmail({ fields, links: { document: item.webUrl } });
    await sendMail({ subject, html, to: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'] }, { fetchImpl });
  } catch (err) {
    console.error('[broker-finalize] email failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'email_failed', detail: String(err) });
    return fail(502, 'email_failed');
  }

  const submissionId = crypto.randomBytes(12).toString('hex');
  try {
    await fetchImpl(`${siteUrl}/.netlify/functions/broker-score-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ submissionId, itemPath: claims.path, fields }),
    });
  } catch (err) {
    // Best-effort: the core submission (ledger + email) above already
    // succeeded — a broker who never gets a score still reaches Gabriel/Eric
    // normally. Log and continue; do not fail the response over this.
    console.error('[broker-finalize] failed to trigger broker-score-background', String(err));
  }

  return ok({ ok: true, submissionId });
};
