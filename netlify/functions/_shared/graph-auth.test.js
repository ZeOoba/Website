'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getGraphToken, _resetCacheForTests } = require('./graph-auth.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) process.env[k] = prev[k]; }
}

test('mints a token via client-credentials and caches it', async () => {
  _resetCacheForTests();
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls += 1;
    assert.equal(url, 'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token');
    assert.match(opts.body, /grant_type=client_credentials/);
    assert.match(opts.body, /scope=https%3A%2F%2Fgraph.microsoft.com%2F.default/);
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
  };
  await withEnv({ GRAPH_TENANT_ID: 'tenant-123', GRAPH_CLIENT_ID: 'client-abc', GRAPH_CLIENT_SECRET: 'secret-xyz' }, async () => {
    const now = () => 1_000_000;
    const t1 = await getGraphToken({ fetchImpl, now });
    const t2 = await getGraphToken({ fetchImpl, now: () => 1_000_000 + 60_000 }); // 1 min later, still cached
    assert.equal(t1, 'tok-1');
    assert.equal(t2, 'tok-1');
    assert.equal(calls, 1, 'second call within expiry window must reuse the cached token');
  });
});

test('re-mints once the cached token is within 5 minutes of expiry', async () => {
  _resetCacheForTests();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ access_token: 'tok-' + calls, expires_in: 3600 }) }; };
  await withEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' }, async () => {
    const base = 1_000_000;
    await getGraphToken({ fetchImpl, now: () => base });
    const t2 = await getGraphToken({ fetchImpl, now: () => base + 3600 * 1000 - 60_000 }); // 1 min before expiry
    assert.equal(t2, 'tok-2');
    assert.equal(calls, 2);
  });
});

test('throws a clear error when credentials are missing', async () => {
  _resetCacheForTests();
  await withEnv({ GRAPH_TENANT_ID: '', GRAPH_CLIENT_ID: '', GRAPH_CLIENT_SECRET: '' }, async () => {
    await assert.rejects(() => getGraphToken({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /missing GRAPH_TENANT_ID/);
  });
});

test('throws when the token endpoint rejects the request', async () => {
  _resetCacheForTests();
  await withEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' }, async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(() => getGraphToken({ fetchImpl }), /token request failed \(401\)/);
  });
});
