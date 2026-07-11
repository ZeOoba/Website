'use strict';
const crypto = require('node:crypto');

function checkHoneypot(fields) {
  const hp = fields && (fields['bot-field'] || fields.website);
  return typeof hp === 'string' && hp.trim() !== '';
}

const MAGIC_SIGNATURES = [
  { ext: 'pdf', mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // .docx/.xlsx/.xls(modern)/.zip all share the ZIP local-file-header signature.
  { ext: 'zip-based', mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
];

function sniffFileType(buffer) {
  for (const sig of MAGIC_SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
      return { ext: sig.ext, mime: sig.mime };
    }
  }
  return null;
}

function extFromFilename(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

// Canonicalize extensions that name the same format so a real file is accepted
// whichever spelling it carries. JPEG has two equally-valid extensions (.jpg /
// .jpeg — many phones/apps save as .jpeg); sniffFileType only ever emits 'jpg'
// for the shared magic-byte signature, so 'jpeg' would otherwise never match.
function canonicalExt(ext) {
  return ext === 'jpeg' ? 'jpg' : ext;
}

function isAllowedUpload(filename, buffer, allowedExts) {
  const declaredExt = extFromFilename(filename);
  if (!allowedExts.includes(declaredExt)) return false;
  const sniffed = sniffFileType(buffer);
  if (!sniffed) return false;
  if (sniffed.ext === 'zip-based') {
    // .docx/.xlsx/.doc/.xls are all zip-or-legacy-OLE containers; accept the
    // zip signature for any allowed Office extension rather than parsing
    // the zip's internal manifest (out of scope — the allowlist + magic
    // bytes together already block a renamed executable, which is the
    // actual threat this guards against).
    return ['docx', 'xlsx', 'xls', 'doc'].includes(declaredExt);
  }
  return canonicalExt(sniffed.ext) === canonicalExt(declaredExt);
}

function sanitizeField(value, maxLen) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function verifyNetlifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (typeof signatureHeader !== 'string') return false;
  const parts = signatureHeader.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return false;
  }
  if (payload.iss !== 'netlify' || typeof payload.sha256 !== 'string') return false;

  const expectedSig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  let actualSig;
  try {
    actualSig = base64urlDecode(sigB64);
  } catch {
    return false;
  }
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) return false;

  const actualBodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(actualBodyHash), Buffer.from(payload.sha256));
}

function signIntakeToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  return `${encoded}.${sig}`;
}

function verifyIntakeToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

module.exports = { checkHoneypot, sniffFileType, isAllowedUpload, sanitizeField, verifyNetlifyWebhookSignature, signIntakeToken, verifyIntakeToken };
