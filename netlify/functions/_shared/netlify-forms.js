'use strict';

const { internalFormHeaders } = require('./internal-forms');

// Returns true on a successful forward, false otherwise — never throws, so
// every existing fire-and-forget caller (that doesn't check the return
// value) keeps working exactly as before. Callers that need to know (e.g.
// broker-finalize.mjs's ledger write) can now react instead of the failure
// vanishing into a console.error only Netlify's ephemeral function logs see.
async function forwardToNetlifyForm(siteUrl, formName, fields, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams();
  params.append('form-name', formName);
  for (const [key, value] of Object.entries(fields)) {
    params.append(key, value == null ? '' : String(value));
  }
  try {
    const res = await fetchImpl(`${siteUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...internalFormHeaders(formName) },
      body: params.toString(),
    });
    if (!res.ok) {
      console.error(`[netlify-forms] forward to "${formName}" failed`, res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[netlify-forms] forward to "${formName}" threw`, String(e));
    return false;
  }
}

module.exports = { forwardToNetlifyForm };
