'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendMail } = require('./graph-mail.js');

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

test('sendMail throws with the status code on failure', async () => {
  process.env.GRAPH_SEND_FROM = 'no-reply@oxfordra.net';
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await assert.rejects(
    () => sendMail({ subject: 's', html: 'h', to: ['a@b.com'] }, { fetchImpl, token: 'tok' }),
    /\(403\)/
  );
});
