// Netlify V2 background function. Must NOT export `handler` -- that marks a
// function as legacy V1, and Blobs auto-provisioning does not cover V1, which is
// what took broker scoring down on 2026-08-04. All orchestration lives in
// _shared/broker-scoring-run.mjs; this file is transport only. That module is
// ESM because it imports broker-score-store.mjs, which must be ESM so esbuild
// bundles @netlify/blobs rather than leaving an unresolvable runtime require.
import { runScoring } from './_shared/broker-scoring-run.mjs';
import { verifyIntakeToken, SUBMISSION_ID_RE, UPLOAD_PATH_RE } from './_shared/validate.js';

// This endpoint is a public Netlify Function URL with no caller identity of
// its own — it is reachable by anyone on the internet, not just
// broker-finalize.mjs. Without the checks below it would let any caller
// choose an arbitrary SharePoint itemPath to read/extract and an arbitrary
// submissionId to persist the result under, then retrieve it unauthenticated
// via broker-score-status.mjs: an unauthenticated read-and-persist oracle
// over the whole GRAPH_DRIVE_ID drive. authToken is minted by
// broker-finalize.mjs (the only legitimate caller) and cryptographically
// binds this exact {submissionId, itemPath} pair; the shape checks below
// (imported from _shared/validate.js, where each value is actually
// generated/defined, rather than a third, independently-hand-written copy)
// are defense-in-depth in case that binding is ever weakened, and now run
// AFTER auth (2026-08-21): checking shape before authentication gave an
// unauthenticated caller a distinguishable 400-vs-401 response revealing
// whether their guessed values matched the expected format.

// deps injection mirrors broker-finalize.mjs's handleBrokerFinalize and
// broker-score-status.mjs's handleScoreStatus, so tests can exercise the
// auth boundary above without a real runScoring call reaching Netlify Blobs
// or Microsoft Graph (or, on a lookup failure, a real network request to
// oxfordra.net's own Netlify Forms endpoint).
export async function handleScoreBackground(req, { runScoringImpl = runScoring } = {}) {
  let body;
  try {
    // Read as text first so an empty body stays {} rather than throwing, which
    // is what the V1 `JSON.parse(event.body || '{}')` did.
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return new Response('invalid_json', { status: 400 });
  }

  const { submissionId, itemPath, fields, authToken } = body;
  if (!submissionId || !itemPath) return new Response('missing_fields', { status: 400 });

  // Auth first (2026-08-21): an unauthenticated caller gets a uniform 401 regardless of whether
  // their submissionId/itemPath happen to match the expected shape, rather than the shape checks
  // (moved below) leaking a 400-vs-401 signal ahead of the auth boundary.
  const claims = verifyIntakeToken(authToken, process.env.INTAKE_TOKEN_SECRET, 'bg-auth');
  if (!claims || claims.submissionId !== submissionId || claims.itemPath !== itemPath) {
    return new Response('invalid_auth', { status: 401 });
  }
  if (!SUBMISSION_ID_RE.test(submissionId)) return new Response('invalid_submission_id', { status: 400 });
  if (!UPLOAD_PATH_RE.test(itemPath)) return new Response('invalid_item_path', { status: 400 });

  await runScoringImpl({ submissionId, itemPath, fields: fields || {} });
  return new Response('', { status: 202 });
}

export default (req) => handleScoreBackground(req);
