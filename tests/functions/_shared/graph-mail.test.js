'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendMail } = require('../../../netlify/functions/_shared/graph-mail.js');

test('sendMail posts to the sendMail endpoint for GRAPH_SEND_FROM with both recipients', async () => {
  process.env.GRAPH_SEND_FROM = 'no-reply@oxfordra.net';
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), method: opts.method };
    return { ok: true, status: 202 };
  };
  await sendMail(
    { subject: 'Hello', html: '<p>Hi</p>', to: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'] },
    { fetchImpl, token: 'tok' }
  );
  assert.equal(captured.url, 'https://graph.microsoft.com/v1.0/users/no-reply@oxfordra.net/sendMail');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body.message.subject, 'Hello');
  assert.deepEqual(
    captured.body.message.toRecipients.map((r) => r.emailAddress.address),
    ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net']
  );
});

test('sendMail passes an optional abort signal to both the token request and the sendMail POST', async () => {
  process.env.GRAPH_SEND_FROM = 'no-reply@oxfordra.net';
  const { _resetCacheForTests } = require('../../../netlify/functions/_shared/graph-auth.js');
  const keys = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' });
  _resetCacheForTests();
  const signal = new AbortController().signal;
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), signal: opts.signal });
    if (String(url).includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, status: 202 };
  };
  try {
    await sendMail({ subject: 's', html: 'h', to: ['a@b.com'] }, { fetchImpl, signal });
    assert.equal(seen.length, 2);
    assert.ok(seen.every((c) => c.signal === signal), 'both Graph calls must carry the caller signal');
  } finally {
    _resetCacheForTests();
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});

test('sendMail without a signal sends none (existing callers unchanged)', async () => {
  process.env.GRAPH_SEND_FROM = 'no-reply@oxfordra.net';
  let opts;
  await sendMail({ subject: 's', html: 'h', to: ['a@b.com'] }, { fetchImpl: async (u, o) => { opts = o; return { ok: true, status: 202 }; }, token: 'tok' });
  assert.equal(opts.signal, undefined);
});

test('sendMail throws with the status code on failure',async () => {
  process.env.GRAPH_SEND_FROM = 'no-reply@oxfordra.net';
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await assert.rejects(
    () => sendMail({ subject: 's', html: 'h', to: ['a@b.com'] }, { fetchImpl, token: 'tok' }),
    /\(403\)/
  );
});
