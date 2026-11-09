'use strict';
const { getGraphToken } = require('./graph-auth.js');

// `signal` (optional) is one deadline shared by the token request and the sendMail POST.
async function sendMail({ subject, html, to }, { fetchImpl = fetch, token, signal } = {}) {
  const from = process.env.GRAPH_SEND_FROM;
  if (!from) throw new Error('graph-mail: missing GRAPH_SEND_FROM');
  const authToken = token || (await getGraphToken({ fetchImpl, signal }));
  const res = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${from}/sendMail`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: 'false',
    }),
  });
  if (!res.ok) throw new Error(`graph-mail: sendMail failed (${res.status})`);
}

module.exports = { sendMail };
