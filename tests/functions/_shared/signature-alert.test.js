'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { alertInvalidSignature, WINDOW_MS, _resetForTests } = require('../../../netlify/functions/_shared/signature-alert.js');
const { _resetCacheForTests } = require('../../../netlify/functions/_shared/graph-auth.js');

const ENV = { GRAPH_SEND_FROM: 'no-reply@oxfordra.net', GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' };

function withEnv(fn) {
  const prev = {};
  for (const k of Object.keys(ENV)) { prev[k] = process.env[k]; process.env[k] = ENV[k]; }
  _resetCacheForTests();
  _resetForTests();
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(ENV)) process.env[k] = prev[k]; });
}

function graph() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, body: String(opts.body || '') });
    if (String(url).includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (String(url).includes('/sendMail')) return { ok: true, status: 202 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchImpl, calls };
}

test('sends one Graph mail to ggoldberg only and never touches Netlify Forms', () => withEnv(async () => {
  const { fetchImpl, calls } = graph();
  assert.equal(await alertInvalidSignature('contact-notify', { fetchImpl }), true);
  const mail = calls.filter((c) => c.url.includes('/sendMail'));
  assert.equal(mail.length, 1);
  assert.ok(mail[0].body.includes('ggoldberg@oxfordra.net'));
  assert.ok(!mail[0].body.includes('egoldberg'), 'alerts route to ggoldberg only');
  assert.ok(!calls.some((c) => c.url === 'https://oxfordra.net/'));
}));

test('is throttled to one mail per hour per instance, then re-arms', () => withEnv(async () => {
  const { fetchImpl, calls } = graph();
  let t = 1_000_000;
  const now = () => t;
  assert.equal(await alertInvalidSignature('a', { fetchImpl, now }), true);
  assert.equal(await alertInvalidSignature('b', { fetchImpl, now }), false);
  t += WINDOW_MS - 1;
  assert.equal(await alertInvalidSignature('c', { fetchImpl, now }), false);
  t += 2;
  assert.equal(await alertInvalidSignature('d', { fetchImpl, now }), true);
  assert.equal(calls.filter((c) => c.url.includes('/sendMail')).length, 2);
}));

test('never throws when Graph fails (the webhook must still return 401)', () => withEnv(async () => {
  const fetchImpl = async () => { throw new Error('graph down'); };
  assert.equal(await alertInvalidSignature('x', { fetchImpl }), false);
}));
