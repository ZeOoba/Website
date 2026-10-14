// Netlify V2 function. Must NOT export `handler` -- that marks a function as
// legacy V1, and Blobs auto-provisioning does not cover V1, which is what took
// broker scoring down on 2026-08-04.
//
// The Blobs-touching chain (broker-score-store.mjs) is ESM so esbuild bundles
// @netlify/blobs into the function. As CommonJS reached from an ESM entry it
// left an unresolvable runtime require -- verified broken on deploy-preview-72.
// Every other _shared module stays CommonJS and untouched.
import { verifyIntakeToken, signIntakeToken, sanitizeField, generateSubmissionId } from './_shared/validate.js';
import { getItemByPath } from './_shared/graph-files.js';
import { sendMail } from './_shared/graph-mail.js';
import { renderBrokerEmail } from './_shared/email-template.js';
import { forwardToNetlifyForm } from './_shared/netlify-forms.js';
import { checkAndRecordRateLimit, checkAndRecordDailyCap, consumeIntakeToken, releaseIntakeToken } from './_shared/broker-score-store.mjs';

// Short-lived HMAC binding {submissionId, itemPath} for the internal
// broker-finalize -> broker-score-background handoff. The background
// function is a public URL with no other caller identity, so without this
// it would trust an attacker-supplied itemPath/submissionId outright (an
// unauthenticated SharePoint read-and-persist oracle). TTL only needs to
// cover the fetch below, not the scoring run itself.
const BG_TOKEN_TTL_MS = 5 * 60 * 1000;

// Bound to the broker-upload.js poll window (MAX_WAIT_MS = 2 min) with headroom. Authorizes the
// broker's own browser to poll broker-score-status.mjs for THIS submissionId -- without it, that
// endpoint would accept any caller-supplied submissionId unauthenticated (the read-side half of
// the SharePoint oracle broker-score-background.mjs's authToken only closes the write side of).
const STATUS_TOKEN_TTL_MS = 10 * 60 * 1000;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const ok = (body) => json(200, body);
const fail = (status, error) => json(status, { ok: false, error });

// submissionId is only known once the id is minted (after the upload checks), so earlier failures log ''.
function logFailure(fetchImpl, { errorCode, detail, submissionId = '' }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(siteUrl, 'pipeline-failures', { 'source-function': 'broker-finalize', 'error-code': errorCode, 'submission-id': submissionId, detail: detail || '', 'occurred-at': new Date().toISOString() }, { fetchImpl });
}

// V2 hands us a Headers object rather than V1's plain lower-cased object.
function getClientIp(headers) {
  const direct = headers.get('x-nf-client-connection-ip');
  if (direct) return direct;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

// The Blobs client retries 429/5xx for ~25 s before it throws. The synchronous function limit is
// shorter (10 s by default), so during a store outage the platform would kill us BEFORE the catch
// below could fail open and log intake_consume_unavailable: the broker would just see a timeout and
// nothing would reach pipeline-failures. Bound the consume well under that limit so an outage takes
// the intended path: fail open AND log.
const CONSUME_TIMEOUT_MS = 4000;
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function handleBrokerFinalize(req, {
  fetchImpl = fetch,
  checkAndRecordRateLimitImpl = checkAndRecordRateLimit,
  checkAndRecordDailyCapImpl = checkAndRecordDailyCap,
  consumeIntakeTokenImpl = consumeIntakeToken,
  releaseIntakeTokenImpl = releaseIntakeToken,
  consumeTimeoutMs = CONSUME_TIMEOUT_MS,
} = {}) {
  if (req.method !== 'POST') return fail(405, 'method_not_allowed');

  let body;
  try {
    // Read as text first so an empty body stays {} rather than throwing, which
    // is what the V1 `JSON.parse(event.body || '{}')` did.
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch { return fail(400, 'invalid_json'); }

  const claims = verifyIntakeToken(body.intakeToken, process.env.INTAKE_TOKEN_SECRET, 'upload');
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

  // Replay guard: the token is valid, the upload exists and matches — burn it
  // now, before anything with a side effect (ledger row, two emails, scoring).
  // Consumed AFTER the lookup so a transient lookup failure leaves the broker's
  // retry intact. Fails OPEN on a store outage (logged to pipeline-failures)
  // because blocking every broker is worse than a window of replayability.
  try {
    const { first } = await withTimeout(consumeIntakeTokenImpl(claims.path, {}), consumeTimeoutMs, 'consumeIntakeToken');
    if (!first) return fail(409, 'intake_token_replayed');
  } catch (err) {
    console.error('[broker-finalize] consumeIntakeToken failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'intake_consume_unavailable', detail: String(err) });
  }

  const fields = {
    name: sanitizeField(body.name, 150),
    company: sanitizeField(body.company, 150),
    email: sanitizeField(body.email, 200),
    phone: sanitizeField(body.phone, 40),
    market: sanitizeField(body.market, 60),
    message: sanitizeField(body.message, 2000),
  };

  // The id is minted BEFORE the contact row so this row and the later score row share a join key
  // (2026-09-30 audit: the contact row used to carry none, so the two could not be tied together).
  const submissionId = generateSubmissionId();
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  // Non-blocking: the broker still gets a success response and Gabriel/Eric
  // still get the email below even if the ledger row fails — but the failure
  // must land in pipeline-failures instead of vanishing, since it previously
  // had no durable trace at all.
  const ledgerOk = await forwardToNetlifyForm(siteUrl, 'broker-network-ledger', { ...fields, 'submission-id': submissionId, 'document-path': claims.path }, { fetchImpl });
  if (!ledgerOk) {
    await logFailure(fetchImpl, { errorCode: 'ledger_write_failed', detail: claims.path, submissionId });
  }

  try {
    const { subject, html } = renderBrokerEmail({ fields, links: { document: item.webUrl } });
    await sendMail({ subject, html, to: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'] }, { fetchImpl });
  } catch (err) {
    console.error('[broker-finalize] email failed', String(err));
    await logFailure(fetchImpl, { errorCode: 'email_failed', detail: String(err), submissionId });
    // The token was burned above; give it back so a retry with the same intakeToken can complete
    // instead of hitting 409. The shipped client does NOT do that: broker-upload.js submit() opens a
    // fresh upload session on every attempt, so a browser resubmit gets a new token, a new submission-id
    // and a second contact row. The contact row written above for THIS attempt keeps its id and never
    // gets a score row; the email_failed row logged here carries the same id, so the orphan stays
    // traceable (2026-10-01 review F4: accepted, documented, not reordered).
    try { await releaseIntakeTokenImpl(claims.path, {}); }
    catch (relErr) { console.error('[broker-finalize] releaseIntakeToken failed', String(relErr)); }
    return fail(502, 'email_failed');
  }

  const statusToken = signIntakeToken(
    { type: 'status', submissionId, exp: Date.now() + STATUS_TOKEN_TTL_MS },
    process.env.INTAKE_TOKEN_SECRET
  );
  try {
    const ip = getClientIp(req.headers);
    // Cost/abuse backstop: reCAPTCHA (Task 13) is the only live gate ahead of
    // this point. These checks are the hard ceiling behind it — a per-IP
    // sliding window and a global UTC-day cap on paid Claude extraction
    // calls — meant to matter precisely when reCAPTCHA itself is defeated.
    // Scoring stays best-effort either way: a rate/cap-limited submission
    // still completes normally for the broker (ledger + email already sent
    // above), it just silently doesn't get scored.
    // Sequential and gated, not Promise.all: the daily cap is a SHARED
    // global counter, so it must only be spent once we know this request
    // would otherwise be eligible to fire the trigger. If the per-IP rate
    // limit already disallows, skip the daily-cap check entirely — a
    // rate-limited IP must not be able to burn through the shared cap
    // (fresh requests count toward it even though the trigger never fires
    // for them) and silently starve every OTHER broker's scoring for the
    // rest of the UTC day.
    const rateLimit = await checkAndRecordRateLimitImpl(ip, {});
    const dailyCap = rateLimit.allowed ? await checkAndRecordDailyCapImpl({}) : null;
    if (rateLimit.allowed && dailyCap && dailyCap.allowed) {
      const authToken = signIntakeToken(
        { type: 'bg-auth', submissionId, itemPath: claims.path, exp: Date.now() + BG_TOKEN_TTL_MS },
        process.env.INTAKE_TOKEN_SECRET
      );
      await fetchImpl(`${siteUrl}/.netlify/functions/broker-score-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submissionId, itemPath: claims.path, fields, authToken }),
      });
    } else {
      console.error('[broker-finalize] scoring skipped: rate/cap limit reached', { ip, rateLimitAllowed: rateLimit.allowed, dailyCapAllowed: dailyCap ? dailyCap.allowed : null });
    }
  } catch (err) {
    // Best-effort: the core submission (ledger + email) above already
    // succeeded — a broker who never gets a score still reaches Gabriel/Eric
    // normally. Log and continue; do not fail the response over this.
    console.error('[broker-finalize] failed to trigger broker-score-background', String(err));
  }

  return ok({ ok: true, submissionId, statusToken });
}

export default (req) => handleBrokerFinalize(req);
