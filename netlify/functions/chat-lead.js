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

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function ok(extra) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
    body: JSON.stringify({ ok: true, ...(extra || {}) }),
  };
}

function bad(reason) {
  return {
    statusCode: 400,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
    body: JSON.stringify({ ok: false, error: reason }),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = new Set(['Broker', 'Prospective Tenant', 'Capital Partner', 'Vendor', 'Other']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'method not allowed' };
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
  const siteUrl = process.env.URL || `https://${event.headers.host}`;
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
