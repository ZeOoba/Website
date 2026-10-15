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
  // An unset/empty secret must fail closed here, not throw out of createHmac:
  // callers console.error (never write a Forms row) when this returns false,
  // so a thrown TypeError would have made a missing secret silent.
  if (typeof secret !== 'string' || !secret) return false;
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

// expectedType (optional, added 2026-08-21): signIntakeToken/verifyIntakeToken are shared across
// multiple trust boundaries that use the SAME INTAKE_TOKEN_SECRET -- the client-facing upload
// token handed to untrusted browsers ({path,size,exp}, type 'upload'), the internal
// broker-finalize->broker-score-background handoff token ({submissionId,itemPath,exp}, type
// 'bg-auth'), and the status-poll token ({submissionId,exp}, type 'status'). Without a type
// claim, cross-boundary replay was blocked only by claim field names happening to differ -- an
// incidental protection a future refactor could silently remove. When expectedType is passed,
// a token whose payload.type doesn't match is rejected even if the signature verifies.
function verifyIntakeToken(token, secret, expectedType) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  let expectedSig;
  try {
    expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  } catch {
    // secret missing/invalid (e.g. an unset env var) -- fail closed, never throw uncaught.
    return null;
  }
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (expectedType !== undefined && payload.type !== expectedType) return null;
  return payload;
}

// Single source of truth for the submissionId shape (finding: broker-score-background.mjs used
// to hand-write a regex re-deriving this format with no link back to the generator -- a future
// change to the byte length here would silently drift from that copy and fail every legitimate
// submission closed). Generator and validator now come from the same constant.
const SUBMISSION_ID_BYTES = 12;
function generateSubmissionId() {
  return crypto.randomBytes(SUBMISSION_ID_BYTES).toString('hex');
}
const SUBMISSION_ID_RE = new RegExp(`^[0-9a-f]{${SUBMISSION_ID_BYTES * 2}}$`);

// Single source of truth for the "Broker Submissions/<date>_<slug>_<hex>/<file>" item-path shape
// broker-upload-session.js's folderPath construction + createUploadSession's appended filename
// produce (finding: broker-score-background.mjs used to hand-write a second copy of this regex
// with no link back to the generator -- a future change to the hex byte length, slug max-length,
// or date format would silently drift from that copy and fail every legitimate submission
// closed). The trailing filename segment stays intentionally permissive ([^/]+) -- it isn't
// validated against sanitizeSegment's exact charset, only confined to a single path segment.
const UPLOAD_PATH_RE = /^Broker Submissions\/\d{4}-\d{2}-\d{2}_[A-Za-z0-9-]{1,60}_[0-9a-f]{8}\/[^/]+$/;

module.exports = {
  checkHoneypot, sniffFileType, isAllowedUpload, sanitizeField, verifyNetlifyWebhookSignature,
  signIntakeToken, verifyIntakeToken, generateSubmissionId, SUBMISSION_ID_RE, UPLOAD_PATH_RE,
};
