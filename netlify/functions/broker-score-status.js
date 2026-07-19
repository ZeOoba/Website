'use strict';
const { readScoreResult } = require('./_shared/broker-score-store.js');

function ok(body) { return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
function fail(statusCode, error) { return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error }) }; }

exports.handler = async (event, { readScoreResultImpl = readScoreResult } = {}) => {
  if (event.httpMethod !== 'GET') return fail(405, 'method_not_allowed');
  const submissionId = event.queryStringParameters && event.queryStringParameters.submissionId;
  if (!submissionId) return fail(400, 'missing_submission_id');

  const result = await readScoreResultImpl(submissionId);
  if (!result) return ok({ status: 'pending' });
  if (result.status === 'unavailable') return ok({ status: 'unavailable' });
  return ok({ status: 'ready', score: result.finalScore, gates: result.gates, gateFailed: result.gateFailed, categories: result.categories });
};
