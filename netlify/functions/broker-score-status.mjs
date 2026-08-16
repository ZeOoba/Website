// Netlify V2 function. Must NOT export `handler` -- that marks a function as
// legacy V1, and Blobs auto-provisioning does not cover V1 (it demands manual
// siteID/token), which is what took broker scoring down on 2026-08-04.
//
// The Blobs-touching chain (broker-score-store.mjs) is ESM so esbuild bundles
// @netlify/blobs into the function. As CommonJS reached from an ESM entry it
// left an unresolvable runtime require -- verified broken on deploy-preview-72.
// Every other _shared module stays CommonJS and untouched.
import { readScoreResult } from './_shared/broker-score-store.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const ok = (body) => json(200, body);
const fail = (status, error) => json(status, { ok: false, error });

export async function handleScoreStatus(req, { readScoreResultImpl = readScoreResult } = {}) {
  if (req.method !== 'GET') return fail(405, 'method_not_allowed');
  const submissionId = new URL(req.url).searchParams.get('submissionId');
  if (!submissionId) return fail(400, 'missing_submission_id');

  let result;
  try {
    result = await readScoreResultImpl(submissionId);
  } catch (err) {
    // Best-effort, same as broker-finalize: a Blobs-layer outage must never
    // surface as a raw 502 to a broker's browser.
    console.error('[broker-score-status] readScoreResult failed', err);
    return ok({ status: 'unavailable' });
  }
  if (!result) return ok({ status: 'pending' });
  if (result.status === 'unavailable') return ok({ status: 'unavailable' });
  return ok({ status: 'ready', score: result.finalScore, gates: result.gates, gateFailed: result.gateFailed, categories: result.categories });
}

export default (req) => handleScoreStatus(req);
