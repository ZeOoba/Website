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

// A protected name, allowing any character to be percent-encoded (`pipeline%2Dfailures`, `%70ipeline…`).
// One linear regex pass: decoding a 1 MiB body first costs more CPU than the edge allows.
const hex = (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0');
const NAME_RE = new RegExp(
  internal.forms.map((n) => [...n].map((c) => `(?:${c.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}|${hex(c)})`).join('')).join('|'),
  'i',
);
const NAME_MAX = Math.max(...internal.forms.map((n) => n.length)) * 3;
// Encodings the platform's parser might undo but we do not.
const ENC_RE = /content-transfer-encoding:\s*(?:quoted-printable|base64)/i;
const SCAN_OVERLAP = Math.max(NAME_MAX, 'content-transfer-encoding: quoted-printable'.length + 8);

// Reads a clone of the body. The first SCAN_LIMIT bytes come back as `text` (latin1). Bytes
// beyond that are scanned chunk by chunk (with an overlap tail) when `scanRest`, else refused:
// `rest` is 'none' | 'clean' | 'hit' (protected name later) | 'encoded' | 'refused'.
async function readBody(req, { scanRest }) {
  if (!req.body) return { text: '', rest: 'none' };
  const reader = req.clone().body.getReader();
  const decoder = new TextDecoder('latin1');
  let text = '';
  let size = 0;
  let rest = 'none';
  let tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let past = value;
    if (size < SCAN_LIMIT) {
      const take = value.subarray(0, SCAN_LIMIT - size);
      text += decoder.decode(take, { stream: true });
      size += take.length;
      past = value.subarray(take.length);
      // Whatever the chunking, the overlap must start from the end of the scanned prefix.
      if (size >= SCAN_LIMIT) tail = text.slice(-SCAN_OVERLAP);
    }
    if (past.length === 0) continue;
    if (!scanRest) {
      rest = 'refused';
    } else {
      const chunk = tail + decoder.decode(past, { stream: true });
      if (NAME_RE.test(chunk)) rest = 'hit';
      else if (ENC_RE.test(chunk)) rest = 'encoded';
      else if (rest === 'none') rest = 'clean';
      tail = chunk.slice(-SCAN_OVERLAP);
      if (rest === 'hit' || rest === 'encoded') {
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
  // remaining bytes are scanned raw (multipart values are never percent-encoded). A multipart
  // type without a boundary is not a real multipart body, so it gets no exemption.
  const contentType = req.headers.get('content-type') || '';
  const multipart = /^multipart\/form-data\s*;.*\bboundary=/i.test(contentType);
  const { text, rest } = await readBody(req, { scanRest: url.pathname === LARGE_BODY_PATH && multipart });
  if (rest === 'refused') return deny(413, 'payload too large');
  const encoded = (req.headers.get('content-encoding') || '').trim().toLowerCase();
  if ((encoded && encoded !== 'identity') || rest === 'encoded' || ENC_RE.test(text)) return deny(415, 'unsupported encoding');
  if (rest !== 'hit' && !NAME_RE.test(text) && !NAME_RE.test(url.search)) return null;
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
  excludedPath: ['/.netlify/*', '/api/chat', '/api/broker-upload-session', '/api/broker-finalize', '/api/broker-score-status'],
  method: 'POST',
  onError: 'bypass',
};
