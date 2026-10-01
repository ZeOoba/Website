// Netlify V2 function. Must NOT export `handler` -- that marks a function as
// legacy V1, and Blobs auto-provisioning does not cover V1 (it demands manual
// siteID/token), which is what took broker scoring down on 2026-08-04.
//
// The Blobs-touching chain (broker-score-store.mjs) is ESM so esbuild bundles
// @netlify/blobs into the function. As CommonJS reached from an ESM entry it
// left an unresolvable runtime require -- verified broken on deploy-preview-72.
// Every other _shared module stays CommonJS and untouched.
import { readScoreResult } from './_shared/broker-score-store.mjs';
import { verifyIntakeToken } from './_shared/validate.js';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const ok = (body) => json(200, body);
const fail = (status, error) => json(status, { ok: false, error });

// Without statusToken, this endpoint used to accept any caller-supplied submissionId
// unauthenticated -- the read-side half of the unauthenticated SharePoint oracle
// broker-score-background.mjs's authToken only closes the write side of (2026-08-21 fix).
// statusToken is minted by broker-finalize.mjs alongside submissionId and cryptographically
// binds the two together.
export async function handleScoreStatus(req, { readScoreResultImpl = readScoreResult } = {}) {
  if (req.method !== 'GET') return fail(405, 'method_not_allowed');
  const params = new URL(req.url).searchParams;
  const submissionId = params.get('submissionId');
  const statusToken = params.get('statusToken');
  if (!submissionId) return fail(400, 'missing_submission_id');

  const claims = verifyIntakeToken(statusToken, process.env.INTAKE_TOKEN_SECRET, 'status');
  if (!claims || claims.submissionId !== submissionId) return fail(401, 'invalid_auth');

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
  // Too little was extractable for a meaningful score (2026-09-30 audit): the broker sees the same
  // "our team will review it directly" message as any other unavailable result, never 0/100 or 100/100.
  if (result.insufficientData) return ok({ status: 'unavailable' });
  // Whitelist the category fields. `internalNote` carries the replacement-cost floor in dollars and is
  // for the internal email and ledger only; it must never reach the browser.
  const categories = (result.categories || []).map((c) => ({
    key: c.key, label: c.label, possible: c.possible, excluded: c.excluded, earned: c.earned, note: c.note,
  }));
  return ok({ status: 'ready', score: result.finalScore, gates: result.gates, gateFailed: result.gateFailed, categories });
}

export default (req) => handleScoreStatus(req);
