/**
 * /api/chat-lead — Captures a lead from the chat widget.
 *
 * Forwards into the Netlify-Forms-registered hidden form `chat-lead`
 * (declared in chat-lead-form.html). Once a submission lands there,
 * the existing scheduled task (sync-lease-applications model) can pull
 * + email Gabriel + Eric. For v1.0 we ALSO do a server-side fetch to
 * Netlify's form-submission endpoint as a safety net so submissions are
 * captured even if the client-side POST is blocked.
 *
 * Always returns 200 {ok: true} unless the request is malformed — never
 * leak internal errors to the client.
 */

const NETLIFY_FORM_NAME = 'chat-lead';

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

exports.handler = async (event) => {
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

  try {
    const r = await fetch(`${siteUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!r.ok) {
      console.error('[chat-lead] netlify form post failed', r.status);
    }
  } catch (e) {
    console.error('[chat-lead] netlify form post threw', String(e));
  }

  // Always return ok — never leak internal errors to the client.
  return ok();
};
