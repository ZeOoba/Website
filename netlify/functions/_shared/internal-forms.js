'use strict';

// Signing side of the internal-forms guard (netlify/edge-functions/forms-guard.ts verifies it).
// Netlify Forms has no auth, so the two function-only forms would otherwise take a forged POST
// from anyone. The edge function rejects a POST that names one of them without this header.
// Signature = HMAC-SHA256(secret, context) in hex: derived, so the stored secret is never sent.

const crypto = require('node:crypto');
const config = require('./internal-forms.json');

function internalFormSecret(env = process.env) {
  for (const name of config.secretEnv) if (env[name]) return env[name];
  return '';
}

function internalFormSignature(secret) {
  return crypto.createHmac('sha256', secret).update(config.context).digest('hex');
}

// Headers a function must add to a POST aimed at `formName` ({} for every other form).
function internalFormHeaders(formName, env = process.env) {
  if (!config.forms.includes(formName)) return {};
  const secret = internalFormSecret(env);
  if (!secret) return {};
  return { [config.header]: internalFormSignature(secret) };
}

module.exports = { internalFormHeaders, internalFormSignature, internalFormSecret, config };
