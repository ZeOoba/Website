// Netlify V2 function. Must NOT export `handler` -- that marks a function as legacy V1, and Blobs
// auto-provisioning does not cover V1 (the reason the throttle for this alert lives HERE and not in the four
// V1 webhook functions that call it).
//
// Sends the "webhook signature rejected" alert to ggoldberg@oxfordra.net at most ONCE PER UTC HOUR, GLOBALLY
// (all four webhook functions, all warm and cold instances). Why a global durable guard: the first version
// throttled per warm instance in memory, so an unauthenticated caller could cause roughly 4 x concurrency mails
// per hour from the same Graph mailbox that sends the real lead notifications (adversarial review of PR #162,
// 2026-10-15), and Graph throttling would then drop real leads.
//
// Mechanism, and the live-measured facts it rests on (deploy-preview probe 2026-10-15):
//   - one create-only key per UTC hour: `store.set(key, body, { onlyIfNew: true })` (sent as If-None-Match: *).
//     Create-only is atomic under contention on the live service (exactly one winner of 30 concurrent writers,
//     4 of 4 trials). An If-Match replace is NOT atomic, so no replace scheme is used here.
//   - `set`, never `setJSON`: in @netlify/blobs 10.7.9 setJSON silently drops the condition.
//   - the client reports {modified:true, etag:''} for every non-412 failure, so a claim without a real ETag is
//     unproven and sends NOTHING. A store error also sends nothing: failing closed is the point, because the
//     alternative is an unbounded per-instance send.
//   - the claim is made BEFORE the send and is not released on failure: a failing Graph is retried at most once
//     per hour, not by every request in the hour (bounded pressure on the shared mailbox). A real rotation
//     keeps 401-ing, so the next hour alerts again.
// Only callable with a short-lived HMAC token minted by the V1 callers (type 'sig-alert'); an unauthenticated
// request is a 401 that does not open the store or touch Graph. The function name in the token is allowlisted.
import { getStore } from '@netlify/blobs';
import { verifyIntakeToken } from './_shared/validate.js';
import { sendMail } from './_shared/graph-mail.js';

const STORE = 'sig-alert';
const ALERT_TO = ['ggoldberg@oxfordra.net'];
const ALLOWED_FNS = new Set(['checklist-notify', 'contact-notify', 'owner-lead-notify', 'tenant-application-processor']);
const MAIL_TIMEOUT_MS = 3000;
const CLAIM_TIMEOUT_MS = 1500; // claim + mail <= 4.5 s, inside the V1 client's 5 s wait

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reply = (sent, reason) => json(200, sent ? { ok: true, sent: true } : { ok: true, sent: false, reason });

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// '2026-10-15T14:30:00.000Z' -> '2026101514'
const hourBucket = (ms) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '');

export async function handleSignatureAlert(req, {
  storeFactory = getStore,
  sendMailImpl = sendMail,
  now = () => Date.now(),
  mailTimeoutMs = MAIL_TIMEOUT_MS,
  claimTimeoutMs = CLAIM_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const secret = process.env.INTAKE_TOKEN_SECRET;
  if (!secret) {
    console.error('[signature-alert] INTAKE_TOKEN_SECRET is not set; cannot authenticate callers');
    return json(500, { ok: false, error: 'not_configured' });
  }

  let body;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch { return json(400, { ok: false, error: 'invalid_json' }); }

  // verifyIntakeToken fails closed by returning null, but a malformed token on a PUBLIC URL must never become an
  // uncaught 500 (a multibyte signature once made its timingSafeEqual throw). Anything that throws is a 401.
  let claims = null;
  try { claims = verifyIntakeToken(body && body.token, secret, 'sig-alert'); } catch { claims = null; }
  if (!claims) return json(401, { ok: false, error: 'invalid_token' });
  if (!ALLOWED_FNS.has(claims.fn)) return json(400, { ok: false, error: 'unknown_function' });

  const at = now();
  const key = `alert-${hourBucket(at)}`;
  let claim;
  try {
    // Bounded: the whole claim + send must fit inside the V1 caller's wait (see CALL_TIMEOUT_MS there), or the
    // hour could be claimed by an invocation that is abandoned before it sends. A timeout fails closed.
    claim = await withTimeout(
      storeFactory(STORE).set(key, JSON.stringify({ fn: claims.fn, at: new Date(at).toISOString() }), { onlyIfNew: true }),
      claimTimeoutMs,
    );
  } catch (err) {
    console.error('[signature-alert] claim failed; sending nothing (fail closed)', String(err));
    return reply(false, 'store_unavailable');
  }
  if (!claim || typeof claim.modified !== 'boolean') {
    console.error('[signature-alert] store did not report `modified`; sending nothing');
    return reply(false, 'unconfirmed');
  }
  if (!claim.modified) return reply(false, 'throttled');
  if (!claim.etag) {
    console.error('[signature-alert] claim reported modified with no etag (the client reports that for failed writes); sending nothing');
    return reply(false, 'unconfirmed');
  }

  try {
    await withTimeout(
      sendMailImpl(
        {
          subject: `[oxfordra.net] Webhook signature rejected (${claims.fn})`,
          html:
            `<p>The <code>${claims.fn}</code> Netlify function rejected a webhook signature that looked like a real one.</p>` +
            '<p>If this is not stray probe traffic, <code>NETLIFY_WEBHOOK_SECRET</code> was likely rotated or is missing, ' +
            'and every form submission is being dropped with a 401 until the secret is corrected in Netlify and in the ' +
            'outgoing-webhook JWS secret.</p>' +
            '<p>This alert is sent at most once per hour across all webhook functions. If it arrives hourly with no ' +
            'rotation, someone is sending forged webhooks to the public function URLs.</p>',
          to: ALERT_TO,
        },
        { fetchImpl: (u, o) => fetchImpl(u, { ...o, signal: AbortSignal.timeout(mailTimeoutMs) }) },
      ),
      mailTimeoutMs,
    );
  } catch (err) {
    console.error('[signature-alert] alert mail failed (hour stays claimed)', String(err));
    return reply(false, 'mail_failed');
  }
  return reply(true);
}

export default (req) => handleSignatureAlert(req);
