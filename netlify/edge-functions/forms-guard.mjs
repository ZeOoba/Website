/**
 * forms-guard — keeps the function-only Netlify Forms (broker-network-ledger, pipeline-failures)
 * from taking forged POSTs.
 *
 * Netlify Forms accepts an unauthenticated POST naming any declared form, so anyone could write
 * ledger/failure rows and burn the Forms quota. Our own functions post to these two forms with an
 * HMAC header (see functions/_shared/internal-forms.js); this edge function, which runs before
 * Forms processing, answers 403 to any POST that mentions one of them without a valid header.
 *
 * Detection is deliberately parser-free: the first 1 MiB of the body (plus the URL) is searched,
 * raw and leniently percent-decoded (bodies past 1 MiB are refused, except multipart on the
 * attachment form, which is scanned to the end), for a protected form name, so content type, field order and encoding
 * tricks cannot hide the name. A legitimate visitor submission never contains those strings.
 *
 * Fails OPEN when no secret is configured (nothing breaks before the env var exists) and when the
 * guard itself errors (onError: bypass in the config below): availability of the real forms wins.
 */

import internal from '../functions/_shared/internal-forms.json' with { type: 'json' };

const SCAN_LIMIT = 1024 * 1024;
// The only public form that legitimately posts more than SCAN_LIMIT (file attachments).
const LARGE_BODY_PATH = '/application-received';

const encoder = new TextEncoder();

export async function signature(secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(internal.context)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Reads a clone of the body. The first SCAN_LIMIT bytes come back as `text` (latin1). If more
// follows, `rest` says what happened to it: 'none' (no more), 'clean' (scanned raw, no protected
// name), 'hit' (a protected name occurs later), 'refused' (too big / not scannable).
async function readBody(req, { scanRest }) {
  if (!req.body) return { text: '', rest: 'none' };
  const reader = req.clone().body.getReader();
  const decoder = new TextDecoder('latin1');
  let text = '';
  let size = 0;
  let rest = 'none';
  let tail = '';
  const overlap = Math.max(...internal.forms.map((n) => n.length)) - 1;
  for (;;) {
    const { done, value: chunkValue } = await reader.read();
    if (done) break;
    let value = chunkValue;
    if (size < SCAN_LIMIT) {
      const take = value.subarray(0, SCAN_LIMIT - size);
      text += decoder.decode(take, { stream: true });
      size += take.length;
      if (take.length === value.length) continue;
      value = value.subarray(take.length);
      tail = text.slice(-overlap).toLowerCase();
    }
    // Past the limit.
    if (!scanRest) {
      rest = 'refused';
    } else {
      const chunk = tail + decoder.decode(value, { stream: true }).toLowerCase();
      if (internal.forms.some((n) => chunk.includes(n))) rest = 'hit';
      else if (rest === 'none') rest = 'clean';
      tail = chunk.slice(-overlap);
      if (rest === 'hit') {
        reader.cancel().catch(() => {});
        break;
      }
      continue;
    }
    // Not awaited: a cloned body is a tee, and its cancel() settles only once the other
    // branch (the one context.next() reads) is also done.
    reader.cancel().catch(() => {});
    break;
  }
  return { text, rest };
}

// Percent-decode leniently: a malformed escape elsewhere in the body must not stop the rest
// from decoding (form parsers keep a bad %xx literal and carry on).
function decoded(raw) {
  return raw.replace(/\+/g, ' ').replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function mentionsProtectedForm(...haystacks) {
  const text = haystacks.flatMap((h) => [h, decoded(h)]).join('\n').toLowerCase();
  return internal.forms.some((name) => text.includes(name));
}

function deny(status, body) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** @returns {Promise<Response|null>} a rejection, or null to let the request through. */
export async function guard(req, { secret }) {
  if (req.method !== 'POST') return null;
  if (!secret) {
    console.warn('[forms-guard] no signing secret configured; internal forms are unguarded');
    return null;
  }
  const url = new URL(req.url);
  // The one public form that legitimately posts >1 MiB (file attachments) is multipart; its
  // remaining bytes are scanned raw (multipart values are never percent-encoded).
  const multipart = /^multipart\/form-data/i.test(req.headers.get('content-type') || '');
  const { text, rest } = await readBody(req, { scanRest: url.pathname === LARGE_BODY_PATH && multipart });
  if (rest === 'refused') return deny(413, 'payload too large');
  // Encodings the platform's parser might undo but we do not: refuse them outright.
  const encoded = (req.headers.get('content-encoding') || '').trim().toLowerCase();
  if ((encoded && encoded !== 'identity') || /content-transfer-encoding:\s*(quoted-printable|base64)/i.test(text)) {
    return deny(415, 'unsupported encoding');
  }
  if (rest !== 'hit' && !mentionsProtectedForm(text, url.search)) return null;
  const presented = req.headers.get(internal.header);
  if (presented && safeEqual(presented, await signature(secret))) return null;
  console.warn('[forms-guard] rejected unsigned POST to an internal form', url.pathname);
  return deny(403, 'forbidden');
}

export default async (req, context) => {
  const secret = internal.secretEnv.map((n) => Netlify.env.get(n)).find(Boolean) || '';
  return (await guard(req, { secret })) ?? context.next();
};


// POST only, every path (Netlify accepts a form POST at any existing path); the platform's own
// endpoints and the chat edge route never carry form submissions.
export const config = {
  path: '/*',
  excludedPath: ['/.netlify/*', '/api/chat', '/api/broker-*'],
  method: 'POST',
  onError: 'bypass',
};
