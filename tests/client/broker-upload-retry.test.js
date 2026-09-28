'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// broker-upload.js is a browser IIFE that attaches window.ORA_BROKER_UPLOAD.
// Run the real file in a vm sandbox with a scripted fetch, so these tests pin
// what a broker on a flaky connection actually experiences: a large OM upload
// used to restart from byte 0 on ANY single dropped chunk (and a 15-minute
// intake token meant a few restarts could lose the deal entirely).
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'broker-upload.js'), 'utf8');
const MIB = 1024 * 1024;

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

function harness({ putResponses }) {
  const delays = [];
  const puts = [];
  let finalizeCalls = 0;
  const queues = new Map(); // chunk start offset -> remaining scripted responses
  for (const [start, script] of Object.entries(putResponses)) queues.set(Number(start), [...script]);

  const fetchImpl = async (url, opts = {}) => {
    if (url === '/api/broker-upload-session') return json({ uploadUrl: 'https://graph.example/upload', intakeToken: 'itok' });
    if (url === '/api/broker-finalize') { finalizeCalls += 1; return json({ ok: true, submissionId: 'sub-1', statusToken: 'st' }); }
    if (url === 'https://graph.example/upload') {
      const range = opts.headers['Content-Range'];
      const start = Number(range.match(/bytes (\d+)-/)[1]);
      puts.push(range);
      const next = (queues.get(start) || [202]).shift();
      if (next === 'throw') throw new TypeError('Failed to fetch');
      return { ok: next < 400, status: next, text: async () => '' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const win = { grecaptcha: { enterprise: { getResponse: () => 'captcha-token' } }, ORA_RECAPTCHA_WIDGET_ID: 0 };
  const ctx = vm.createContext({ window: win, fetch: fetchImpl, setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0; }, console });
  vm.runInContext(SRC, ctx);

  const file = { name: 'om.pdf', size: 12 * MIB, type: 'application/pdf', slice: () => ({}) }; // 5 + 5 + 2 MiB chunks
  const values = { name: 'Bob', company: 'Acme', email: 'b@acme.com', phone: '555', market: 'Columbus', message: 'hi', website: '' };
  const form = {
    querySelector(sel) {
      const m = sel.match(/^\[name="(\w+)"\]$/);
      if (m) return { value: values[m[1]] };
      if (sel === 'input[type="file"]') return { files: [file] };
      return null;
    },
  };
  return { submit: () => win.ORA_BROKER_UPLOAD.submit(form), delays, puts, finalizeCalls: () => finalizeCalls };
}

test('a transient 503 on one chunk is retried in place, then the upload completes', async () => {
  const h = harness({ putResponses: { 0: [503, 202] } });
  const result = await h.submit();
  assert.equal(result.submissionId, 'sub-1');
  assert.equal(h.puts.length, 4, '3 chunks + exactly 1 retry');
  assert.equal(h.puts[0], h.puts[1], 'the retry must resend the SAME byte range, not restart from byte 0');
  assert.deepEqual(h.delays, [500], 'backoff before the retry');
  assert.equal(h.finalizeCalls(), 1);
});

test('a dropped connection (fetch throws) mid-upload is retried and does not restart earlier chunks', async () => {
  const h = harness({ putResponses: { [5 * MIB]: ['throw', 202] } });
  await h.submit();
  assert.equal(h.puts.length, 4);
  assert.equal(h.puts.filter((r) => r.startsWith('bytes 0-')).length, 1, 'chunk 1 must be sent once, not resent after chunk 2 hiccups');
});

test('gives up after 3 attempts on one chunk with the original error code and never finalizes', async () => {
  const h = harness({ putResponses: { 0: [503, 503, 503] } });
  await assert.rejects(h.submit(), /chunk_upload_failed:503/);
  assert.equal(h.puts.length, 3);
  assert.deepEqual(h.delays, [500, 1500], 'exponential backoff between attempts');
  assert.equal(h.finalizeCalls(), 0, 'a half-uploaded file must not be finalized');
});

test('a permanent client error (403: session dead) is not retried', async () => {
  const h = harness({ putResponses: { 0: [403] } });
  await assert.rejects(h.submit(), /chunk_upload_failed:403/);
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.delays, []);
});

test('a connection that never comes back fails with a clean chunk_upload_failed:network code', async () => {
  const h = harness({ putResponses: { 0: ['throw', 'throw', 'throw'] } });
  await assert.rejects(h.submit(), /chunk_upload_failed:network/);
  assert.equal(h.puts.length, 3);
});
