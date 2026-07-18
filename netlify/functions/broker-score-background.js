'use strict';
const { getItemByPath, getFileContent } = require('./_shared/graph-files.js');
const { extractForScoring } = require('./_shared/broker-extraction.js');
const { extractDealTerms } = require('./_shared/broker-llm-extract.js');
const { scoreDeal } = require('./_shared/broker-score-engine.js');
const { writeScoreResult, hasBeenScored, markScored } = require('./_shared/broker-score-store.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');
const { sendMail } = require('./_shared/graph-mail.js');
const { renderScoreFollowupEmail } = require('./_shared/email-template.js');
const rctBenchmark = require('./_shared/rct-benchmark.json');

function extFromPath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return m ? m[1].toLowerCase() : '';
}

async function logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  await forwardToNetlifyFormImpl(siteUrl, 'pipeline-failures', {
    'source-function': 'broker-score-background', 'error-code': errorCode,
    'submission-id': submissionId, detail: detail || '', 'occurred-at': new Date().toISOString(),
  }, { fetchImpl });
}

async function runScoring({ submissionId, itemPath, fields }, deps = {}) {
  const {
    fetchImpl = fetch,
    getItemByPathImpl = getItemByPath,
    getFileContentImpl = getFileContent,
    extractForScoringImpl = extractForScoring,
    extractDealTermsImpl = extractDealTerms,
    scoreDealImpl = scoreDeal,
    writeScoreResultImpl = writeScoreResult,
    hasBeenScoredImpl = hasBeenScored,
    markScoredImpl = markScored,
    forwardToNetlifyFormImpl = forwardToNetlifyForm,
    sendMailImpl = sendMail,
  } = deps;

  if (await hasBeenScoredImpl(itemPath)) {
    return { ok: true, skipped: 'already_scored' };
  }
  await markScoredImpl(itemPath);

  let item;
  try {
    item = await getItemByPathImpl(itemPath, { fetchImpl });
  } catch (err) {
    await writeScoreResultImpl(submissionId, { status: 'unavailable', reason: 'lookup_failed' });
    await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: 'lookup_failed', detail: String(err) });
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!item) {
    await writeScoreResultImpl(submissionId, { status: 'unavailable', reason: 'item_not_found' });
    await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: 'item_not_found', detail: itemPath });
    return { ok: false, reason: 'item_not_found' };
  }

  let buffer;
  try {
    buffer = await getFileContentImpl(itemPath, { fetchImpl });
  } catch (err) {
    await writeScoreResultImpl(submissionId, { status: 'unavailable', reason: 'download_failed' });
    await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: 'download_failed', detail: String(err) });
    return { ok: false, reason: 'download_failed' };
  }
  if (!buffer) {
    await writeScoreResultImpl(submissionId, { status: 'unavailable', reason: 'download_failed' });
    await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: 'download_failed', detail: itemPath });
    return { ok: false, reason: 'download_failed' };
  }

  const content = await extractForScoringImpl(buffer, extFromPath(itemPath));
  if (!content.ok) {
    await writeScoreResultImpl(submissionId, { status: 'unavailable', reason: content.reason });
    await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: content.reason, detail: itemPath });
    return { ok: false, reason: content.reason };
  }

  let extracted;
  try {
    extracted = await extractDealTermsImpl(content, { fetchImpl });
  } catch (err) {
    await writeScoreResultImpl(submissionId, { status: 'unavailable', reason: 'llm_extraction_failed' });
    await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: 'llm_extraction_failed', detail: String(err) });
    return { ok: false, reason: 'llm_extraction_failed' };
  }

  const result = scoreDealImpl(extracted, rctBenchmark);
  await writeScoreResultImpl(submissionId, { status: 'ready', ...result });

  const siteUrl = process.env.URL || 'https://oxfordra.net';

  try {
    const { subject, html } = renderScoreFollowupEmail({ fields, score: result });
    await sendMailImpl({ subject, html, to: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'] }, { fetchImpl });
  } catch (err) {
    // Scoring already succeeded and is persisted for the broker's poll to
    // pick up — a follow-up email failure is logged, not fatal to the result.
    await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: 'followup_email_failed', detail: String(err) });
  }

  await forwardToNetlifyFormImpl(siteUrl, 'broker-network-ledger', {
    'submission-id': submissionId,
    'score-total': result.finalScore,
    'score-gate-property-type': result.gates.propertyType,
    'score-gate-market': result.gates.market,
    'score-breakdown': JSON.stringify(result.categories),
  }, { fetchImpl });

  return { ok: true, result };
}

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'invalid_json' }; }
  const { submissionId, itemPath, fields } = body;
  if (!submissionId || !itemPath) return { statusCode: 400, body: 'missing_fields' };
  await runScoring({ submissionId, itemPath, fields: fields || {} });
  return { statusCode: 202, body: '' };
};

exports.runScoring = runScoring;
