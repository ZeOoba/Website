'use strict';

let cached = null; // { token, expiresAt }

// `signal` (optional) bounds the token request; an aborted request rejects and caches nothing.
async function getGraphToken({ fetchImpl = fetch, now = () => Date.now(), signal } = {}) {
  if (cached && cached.expiresAt - 300_000 > now()) {
    return cached.token;
  }
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('graph-auth: missing GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET env vars');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  if (!res.ok) {
    throw new Error(`graph-auth: token request failed (${res.status})`);
  }
  const json = await res.json();
  cached = { token: json.access_token, expiresAt: now() + json.expires_in * 1000 };
  return cached.token;
}

function _resetCacheForTests() {
  cached = null;
}

module.exports = { getGraphToken, _resetCacheForTests };
