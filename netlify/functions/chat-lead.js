/**
 * /api/chat-lead — Captures a lead from the chat widget.
 *
 * Forwards into the Netlify-Forms-registered hidden form `chat-lead`
 * (declared in chat-lead-form.html). The notification is NOT sent from this
 * repo: the site's Netlify form notifications email ggoldberg@ and egoldberg@
 * for every `chat-lead` row (read from the live hooks list, 2026-11-05), so a
 * stored row is the whole happy path.
 *
 * That notification only exists if the row does. When the forward fails or
 * throws, this function emails the lead itself through Microsoft Graph and logs
 * a `pipeline-failures` row, so a lead is never dropped while the visitor is
 * told "we will be in touch". Only when the row AND the fallback email both
 * fail does the visitor get {ok:false}; assets/chat.js then shows its
 * email-us-directly message. Error detail never reaches the client.
 */

const { sendMail } = require('./_shared/graph-mail.js');
const { forwardToNetlifyForm } = require('./_shared/netlify-forms.js');

const NETLIFY_FORM_NAME = 'chat-lead';
// Same recipients as the native chat-lead notification and every other lead notice.
const NOTIFY_TO = ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'];

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFallbackEmail(fields) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#596B7D;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#2D2D2D;white-space:pre-wrap;">${escapeHtml(v)}</td></tr>`)
    .join('');
  return {
    subject: `New Chat Lead — ${fields.Role || 'Unknown role'} (${fields.Name || 'Unknown'})`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#F5F3EF;">
<div style="max-width:640px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;">
  <div style="background:#1B2A4A;padding:24px 32px;"><h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:400;">Chat Lead</h1></div>
  <div style="background:#ffffff;padding:24px 32px;"><table style="width:100%;border-collapse:collapse;">${rows}</table></div>
  <div style="padding:16px 32px;font-family:Arial,sans-serif;font-size:11px;color:#596B7D;">Oxford Realty Advisors — sent directly because the Netlify Forms row failed or did not confirm in time. If Netlify's usual notice for this lead also arrives, the row was stored after all; this is the same lead.</div>
</div></body></html>`,
  };
}

// The failure row goes to the same Netlify Forms endpoint that may just have failed, so it is bounded: it must
// never hold the visitor's response past the function's ~10 s limit (a lead already emailed would then be told
// it failed). A row that does not land in time is lost; the console.error above it stays in the function log.
function logFailure(fetchImpl, siteUrl, errorCode, detail) {
  const write = forwardToNetlifyForm(siteUrl, 'pipeline-failures', {
    'source-function': 'chat-lead', 'error-code': errorCode, 'submission-id': '', detail: detail || '', 'occurred-at': new Date().toISOString(),
  }, { fetchImpl });
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(() => resolve(false), Number(process.env.CHAT_LEAD_LOG_TIMEOUT_MS) || 1500); });
  return Promise.race([write, cap]).finally(() => clearTimeout(timer));
}

// ---------- CORS ----------
// The widget (assets/chat.js) calls this as a RELATIVE path, so every
// legitimate request is same-origin and CORS never gates it. The previous
// 'access-control-allow-origin: *' therefore bought nothing and let any
// third-party page script leads into Netlify Forms and the notification
// webhook chain against a visitor's browser. Mirror the edge chat function
// (netlify/edge-functions/chat.ts): reflect the caller's Origin only when it
// is one of ours (canonical + Netlify's own deploy URLs), else the canonical.
const CANONICAL_ORIGIN = 'https://oxfordra.net';
const STATIC_ALLOWED = ['https://oxfordra.net', 'https://www.oxfordra.net'];

function originOf(value) {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

let allowedOrigins = null;
function allowSet() {
  if (allowedOrigins) return allowedOrigins;
  const set = new Set(STATIC_ALLOWED);
  for (const key of ['URL', 'DEPLOY_URL', 'DEPLOY_PRIME_URL']) {
    const o = originOf(process.env[key]);
    if (o) set.add(o);
  }
  allowedOrigins = set;
  return set;
}

function corsHeaders(event) {
  const origin = event && event.headers ? event.headers.origin || event.headers.Origin : null;
  return {
    'access-control-allow-origin': origin && allowSet().has(origin) ? origin : CANONICAL_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

// ---------- Rate limit (in-memory, per container) ----------
// Same shape as broker-upload-session.js: a sliding window per client IP. The
// ceiling is per container, not global, which is the right order of magnitude
// for what this protects — Netlify Forms quota and two webhook invocations per
// row — without a Blobs dependency on a function that has none today.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_IP = 5;
const rateBuckets = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX_PER_IP) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - bucket[0])) / 1000)) };
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // bound memory on a long-lived container
  return { ok: true };
}

function clientIp(event) {
  const h = event.headers || {};
  const direct = h['x-nf-client-connection-ip'];
  if (direct) return direct;
  const forwarded = h['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return 'unknown';
}

function respond(event, statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...corsHeaders(event), ...(extraHeaders || {}) },
    body: JSON.stringify(body),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = new Set(['Broker', 'Prospective Tenant', 'Capital Partner', 'Vendor', 'Other']);

// Netlify passes (event, context); context has no fetchImpl, so production uses the global fetch.
exports.handler = async (event, { fetchImpl = fetch } = {}) => {
  const ok = (extra) => respond(event, 200, { ok: true, ...(extra || {}) });
  const bad = (reason) => respond(event, 400, { ok: false, error: reason });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'method not allowed' };
  }

  const limit = rateLimit(clientIp(event));
  if (!limit.ok) {
    return respond(event, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(limit.retryAfter) });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad('invalid_json'); }

  // Honeypot — bots fill this. Reject silently with 200 so they think it worked.
  if (body.website && String(body.website).trim() !== '') {
    return ok();
  }

  const name    = typeof body.name === 'string' ? body.name.trim() : '';
  const email   = typeof body.email === 'string' ? body.email.trim() : '';
  const phone   = typeof body.phone === 'string' ? body.phone.trim() : '';
  const role    = typeof body.role === 'string' ? body.role.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : '';
  // First page of the visit (utm_* only) and the referring HOSTNAME, from script.js's window.ORA_LEAD_SOURCE().
  // eslint-disable-next-line no-control-regex
  const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '');
  const leadLanding = clean(body.leadLanding, 300);
  const leadReferrer = clean(body.leadReferrer, 120);
  const transcript = Array.isArray(body.transcript)
    ? body.transcript.slice(-10).filter((t) => t && typeof t.role === 'string' && typeof t.content === 'string')
    : [];

  if (!name || name.length > 200) return bad('invalid_name');
  if (!EMAIL_RE.test(email)) return bad('invalid_email');
  if (!ROLES.has(role)) return bad('invalid_role');
  if (!message || message.length < 10 || message.length > 2000) return bad('invalid_message');
  if (phone && phone.length > 40) return bad('invalid_phone');

  // Format transcript as plain text
  const transcriptText = transcript
    .map((t) => `[${t.role}] ${t.content}`.slice(0, 800))
    .join('\n---\n');

  // Submit to Netlify Forms. URL-encoded POST to the same site root with form-name field.
  // Literal fallback like every other function: never trust the Host header.
  const siteUrl = process.env.URL || CANONICAL_ORIGIN;
  const params = new URLSearchParams();
  params.append('form-name', NETLIFY_FORM_NAME);
  params.append('name', name);
  params.append('email', email);
  params.append('phone', phone);
  params.append('role', role);
  params.append('message', message);
  params.append('session-id', sessionId);
  params.append('transcript', transcriptText);
  params.append('submitted-at', new Date().toISOString());
  params.append('lead-landing', leadLanding);
  params.append('lead-referrer', leadReferrer);

  let storeDetail = '';
  try {
    // Bounded: a hung Forms write must leave time in the function's ~10 s budget for the email fallback below.
    const timeoutMs = Number(process.env.CHAT_LEAD_FORMS_TIMEOUT_MS) || 4000;
    const r = await fetchImpl(`${siteUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) return ok();
    storeDetail = `status ${r.status}`;
    console.error('[chat-lead] netlify form post failed', r.status);
  } catch (e) {
    storeDetail = String(e);
    console.error('[chat-lead] netlify form post threw', storeDetail);
  }

  // The row was not stored, so no native notification will fire: email the lead directly, then record why.
  try {
    const { subject, html } = renderFallbackEmail({
      Name: name, Email: email, Phone: phone, Role: role, Message: message,
      'Landing Page': leadLanding, 'Referred From': leadReferrer,
      'Session ID': sessionId, Transcript: transcriptText,
    });
    // One deadline across the Graph token AND sendMail: Forms 4 s + Graph 3.5 s + failure log 1.5 s = 9 s worst
    // case, under the ~10 s function limit, so a timed-out email still reaches the failure row and a JSON reply.
    const graphTimeoutMs = Number(process.env.CHAT_LEAD_GRAPH_TIMEOUT_MS) || 3500;
    await sendMail({ subject, html, to: NOTIFY_TO }, { fetchImpl, signal: AbortSignal.timeout(graphTimeoutMs) });
  } catch (err) {
    console.error('[chat-lead] fallback email failed', String(err));
    await logFailure(fetchImpl, siteUrl, 'fallback_email_failed', `forward: ${storeDetail}; email: ${String(err)}`);
    // Nothing captured the lead: say so (generically) so the widget offers the direct email address.
    return respond(event, 502, { ok: false, error: 'unavailable' });
  }
  await logFailure(fetchImpl, siteUrl, 'forms_forward_failed', `${storeDetail} (lead emailed directly)`);
  return ok();
};
