'use strict';

async function forwardToNetlifyForm(siteUrl, formName, fields, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams();
  params.append('form-name', formName);
  for (const [key, value] of Object.entries(fields)) {
    params.append(key, value == null ? '' : String(value));
  }
  try {
    const res = await fetchImpl(`${siteUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      console.error(`[netlify-forms] forward to "${formName}" failed`, res.status);
    }
  } catch (e) {
    console.error(`[netlify-forms] forward to "${formName}" threw`, String(e));
  }
}

module.exports = { forwardToNetlifyForm };
