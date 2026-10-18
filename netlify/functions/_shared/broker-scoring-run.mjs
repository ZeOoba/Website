// Scoring orchestration, moved verbatim out of netlify/functions/broker-score-background.js
// when that function migrated to the Netlify V2 signature (2026-08-16).
//
// ESM because it imports broker-score-store.mjs, which must be ESM so esbuild
// bundles @netlify/blobs into the function rather than leaving an unresolvable
// runtime require. The logic below is unchanged from the V1 original.
import { getItemByPath, getFileContent } from './graph-files.js';
import { extractForScoring } from './broker-extraction.mjs';
import { extractDealTerms } from './broker-llm-extract.js';
import { scoreDeal } from './broker-score-engine.js';
import { writeScoreResult, hasBeenScored, markScored } from './broker-score-store.mjs';
import { forwardToNetlifyForm } from './netlify-forms.js';
import { sendMail } from './graph-mail.js';
import { renderScoreFollowupEmail } from './email-template.js';
import rctBenchmark from './rct-benchmark-data.js';

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

  try {
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
      'score-total': result.finalScore == null ? '' : result.finalScore,
      'score-coverage': result.coveragePct,
      // A needs-review hold and a low-coverage withhold both leave score-total empty; this tells them apart
      // at the row level (reasons are in score-breakdown's internal notes and the review email).
      'score-needs-review': result.needsReview ? 'true' : 'false',
      'score-gate-property-type': result.gates.propertyType,
      'score-gate-market': result.gates.market,
      'score-breakdown': JSON.stringify(result.categories),
    }, { fetchImpl });

    return { ok: true, result };
  } catch (err) {
    // Last-resort catch-all: anything that escapes the specific handlers
    // above (unguarded Blobs I/O in hasBeenScoredImpl/markScoredImpl/
    // writeScoreResultImpl, or a malformed-shape throw from scoreDealImpl)
    // must never propagate out of runScoring. Per the plan's Global
    // Constraints, a scoring failure of any kind must never block the
    // existing ledger-log + Gabriel/Eric email in broker-finalize.
    try {
      await writeScoreResultImpl(submissionId, { status: 'unavailable', reason: 'unexpected_error' });
    } catch (writeErr) {
      // Best-effort only — don't let a failure here escape either.
      console.error('broker-score-background: failed to write unavailable result after unexpected_error', writeErr);
    }
    try {
      await logFailure(forwardToNetlifyFormImpl, fetchImpl, { submissionId, errorCode: 'unexpected_error', detail: String(err) });
    } catch (logErr) {
      // Best-effort only — don't let a failure here escape either.
      console.error('broker-score-background: failed to log failure after unexpected_error', logErr);
    }
    return { ok: false, reason: 'unexpected_error' };
  }
}

export { runScoring };
