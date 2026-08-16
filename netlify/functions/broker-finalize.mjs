// Netlify V2 function. Must NOT export `handler` -- that marks a function as
// legacy V1, and Blobs auto-provisioning does not cover V1, which is what took
// broker scoring down on 2026-08-04.
//
// The Blobs-touching chain (broker-score-store.mjs) is ESM so esbuild bundles
// @netlify/blobs into the function. As CommonJS reached from an ESM entry it
// left an unresolvable runtime require -- verified broken on deploy-preview-72.
// Every other _shared module stays CommonJS and untouched.
import crypto from 'node:crypto';
import { verifyIntakeToken, sanitizeField } from './_shared/validate.js';
import { getItemByPath } from './_shared/graph-files.js';
import { sendMail } from './_shared/graph-mail.js';
import { renderBrokerEmail } from './_shared/email-template.js';
import { forwardToNetlifyForm } from './_shared/netlify-forms.js';
import { checkAndRecordRateLimit, checkAndRecordDailyCap } from './_shared/broker-score-store.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const ok = (body) => json(200, body);
const fail = (status, error) => json(status, { ok: false, error });

function logFailure(fetchImpl, { errorCode, detail }) {
  const siteUrl = process.env.URL || 'https://oxfordra.net';
  return forwardToNetlifyForm(siteUrl, 'pipeline-failures', { 'source-function': 'broker-finalize', 'error-code': errorCode, 'submission-id': '', detail: detail || '', 'occurred-at': new Date().toISOString() }, { fetchImpl });
}

// V2 hands us a Headers object rather than V1's plain lower-cased object.
function getClientIp(headers) {
  const direct = headers.get('x-nf-client-connection-ip');
  if (direct) return direct;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

export async function handleBrokerFinalize(req, {
  fetchImpl = fetch,
  checkAndRecordRateLimitImpl = checkAndRecordRateLimit,
  checkAndRecordDailyCapImpl = checkAndRecordDailyCap,
} = {}) {
  if (req.method !== 'POST') return fail(405, 'method_not_allowed');

  let body;
  try {
    // Read as text first so an empty body stays {} rather than throwing, which
    // is what the V1 `JSON.parse(event.body || '{}')` did.
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch { return fail(400, 'invalid_json'); }

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
      await fetchImpl(`${siteUrl}/.netlify/functions/broker-score-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submissionId, itemPath: claims.path, fields }),
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

  return ok({ ok: true, submissionId });
}

export default (req) => handleBrokerFinalize(req);
