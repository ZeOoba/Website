'use strict';
// Loud-but-bounded alert for a rejected webhook signature.
//
// A rotated or missing NETLIFY_WEBHOOK_SECRET makes every submission-created webhook 401, silently dropping
// leads. The old fix wrote a pipeline-failures Forms row, which re-fired every webhook (exponential loop) and
// let unauthenticated POSTs burn the Forms quota. This surfaces the same condition over Graph mail instead:
// it never touches Netlify Forms, and it is throttled to one mail per hour per warm function instance (the same
// in-memory scope as the other limiters here), so a flood of forged requests sends at most that many.
const { sendMail } = require('./graph-mail.js');

const WINDOW_MS = 60 * 60 * 1000;
const ALERT_TO = ['ggoldberg@oxfordra.net'];
let lastSentAt = 0;

async function alertInvalidSignature(fnName, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const t = now();
  if (lastSentAt && t - lastSentAt < WINDOW_MS) return false;
  lastSentAt = t; // claim the window before awaiting so concurrent requests cannot all send
  try {
    await sendMail(
      {
        subject: `[oxfordra.net] Webhook signature rejected (${fnName})`,
        html:
          `<p>The <code>${fnName}</code> Netlify function rejected a webhook signature.</p>` +
          '<p>If this is not a stray forged request, <code>NETLIFY_WEBHOOK_SECRET</code> was likely rotated or is ' +
          'missing, and every form submission is being dropped with a 401 until the secret is corrected in Netlify ' +
          'and the outgoing-webhook JWS secret.</p>' +
          '<p>This alert is sent at most once per hour per function instance.</p>',
        to: ALERT_TO,
      },
      { fetchImpl },
    );
    return true;
  } catch (e) {
    console.error(`[${fnName}] signature alert mail failed:`, e instanceof Error ? e.message : String(e));
    return false;
  }
}

function _resetForTests() {
  lastSentAt = 0;
}

module.exports = { alertInvalidSignature, WINDOW_MS, _resetForTests };
