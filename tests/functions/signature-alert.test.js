'use strict';
/**
 * signature-alert.mjs (V2): the GLOBAL, durable once-per-hour guard and the only place the alert mail is sent.
 *
 * Live-measured facts this design rests on (probe on a deploy preview, 2026-10-15, see memory
 * netlify-blobs-live-semantics): a create-only write (`set` with onlyIfNew, i.e. If-None-Match: *) is atomic
 * under contention (exactly one winner of 30 concurrent writers, 4 of 4 trials); an If-Match replace is NOT;
 * `setJSON` drops conditions; a non-412 failure is reported as {modified:true, etag:''}. So: one create-only
 * key per UTC hour, `set` not `setJSON`, and an empty etag is never trusted as a win.
 *
 * The store fake below is faithful to those behaviours so that a regression to setJSON or to an If-Match
 * scheme fails these tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { signIntakeToken } = require('../../netlify/functions/_shared/validate.js');

let modPromise;
const load = () => (modPromise ||= import(pathToFileURL(path.join(__dirname, '..', '..', 'netlify', 'functions', 'signature-alert.mjs')).href));

const SECRET = 'intake-secret';
const ENV = { INTAKE_TOKEN_SECRET: SECRET };
function withEnv(fn, over = {}) {
  const vars = { ...ENV, ...over };
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

const token = (over = {}) => signIntakeToken({ type: 'sig-alert', fn: 'contact-notify', exp: Date.now() + 60_000, ...over }, SECRET);
const req = (body, method = 'POST') => new Request('https://oxfordra.net/.netlify/functions/signature-alert', {
  method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});

/** Faithful fake of the Blobs behaviours that matter: atomic create-only, setJSON drops conditions, optional quirks. */
function fakeStores({ latencyMs = 0, quirk = null } = {}) {
  const data = new Map();
  const opened = [];
  let etagSeq = 0;
  const tick = () => new Promise((r) => setTimeout(r, latencyMs));
  return {
    data, opened,
    storeFactory: (name) => {
      opened.push(name);
      return {
        async set(key, body, opts = {}) {
          await tick();
          if (quirk === 'throws') throw new Error('blobs down');
          if (quirk === 'emptyEtag') return { modified: true, etag: '' }; // the real client's report for a failed write
          if (opts.onlyIfNew && data.has(`${name}:${key}`)) return { modified: false };
          data.set(`${name}:${key}`, body);
          return { modified: true, etag: `"e${++etagSeq}"` };
        },
        async setJSON(key, value) { await tick(); data.set(`${name}:${key}`, JSON.stringify(value)); return { modified: true, etag: `"j${++etagSeq}"` }; },
      };
    },
  };
}
const mailer = () => { const sent = []; return { sent, sendMailImpl: async (msg) => { sent.push(msg); } }; };
const call = async (deps, r = req({ token: token() })) => { const { handleSignatureAlert } = await load(); const res = await handleSignatureAlert(r, deps); return { status: res.status, body: await res.json() }; };

test('only POST is accepted', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores();
  const r = await call({ storeFactory: s.storeFactory, ...m }, req(null, 'GET'));
  assert.equal(r.status, 405);
  assert.deepEqual(m.sent, []);
  assert.equal(s.opened.length, 0);
}));

test('no token, a bad token, a wrong-type token and an expired token are all 401 with ZERO store or mail activity', () => withEnv(async () => {
  const bodies = [
    {}, { token: 'nope' }, { token: 'a.b' },
    { token: signIntakeToken({ type: 'upload', fn: 'contact-notify', exp: Date.now() + 60_000 }, SECRET) },     // wrong type
    { token: signIntakeToken({ type: 'sig-alert', fn: 'contact-notify', exp: Date.now() - 1 }, SECRET) },       // expired
    { token: signIntakeToken({ type: 'sig-alert', fn: 'contact-notify', exp: Date.now() + 60_000 }, 'other') }, // forged
  ];
  for (const b of bodies) {
    const m = mailer(); const s = fakeStores();
    const r = await call({ storeFactory: s.storeFactory, ...m }, req(b));
    assert.equal(r.status, 401, JSON.stringify(b).slice(0, 60));
    assert.deepEqual(m.sent, []);
    assert.equal(s.opened.length, 0, 'an unauthenticated request must not even open the store');
  }
  const m = mailer(); const s = fakeStores();
  assert.equal((await call({ storeFactory: s.storeFactory, ...m }, req('{not json'))).status, 400);
}));

test('a valid request claims the hour with a CREATE-ONLY key and sends one mail to ggoldberg only', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores();
  const now = () => Date.UTC(2026, 9, 15, 14, 30, 0);
  const r = await call({ storeFactory: s.storeFactory, ...m, now });
  assert.deepEqual(r.body, { ok: true, sent: true });
  assert.equal(m.sent.length, 1);
  assert.deepEqual(m.sent[0].to, ['ggoldberg@oxfordra.net']);
  assert.match(m.sent[0].subject, /contact-notify/);
  assert.ok([...s.data.keys()].some((k) => k === 'sig-alert:alert-2026101514'), `claim key was ${[...s.data.keys()]}`);
}));

test('50 concurrent valid requests in the same hour send exactly ONE mail (the global guard)', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores({ latencyMs: 15 });
  const now = () => Date.UTC(2026, 9, 15, 14, 30, 0);
  const rs = await Promise.all(Array.from({ length: 50 }, () => call({ storeFactory: s.storeFactory, ...m, now })));
  assert.equal(m.sent.length, 1, `sent ${m.sent.length} mails`);
  assert.equal(rs.filter((r) => r.body.sent).length, 1);
  assert.ok(rs.every((r) => r.status === 200));
}));

test('a new UTC hour re-arms the guard; the same hour does not', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores();
  let t = Date.UTC(2026, 9, 15, 14, 0, 1);
  const now = () => t;
  await call({ storeFactory: s.storeFactory, ...m, now });
  t = Date.UTC(2026, 9, 15, 14, 59, 59);
  await call({ storeFactory: s.storeFactory, ...m, now });
  assert.equal(m.sent.length, 1);
  t = Date.UTC(2026, 9, 15, 15, 0, 0);
  await call({ storeFactory: s.storeFactory, ...m, now });
  assert.equal(m.sent.length, 2);
}));

test('FAILS CLOSED: a claim reported as modified:true with an empty etag is unproven, so no mail', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores({ quirk: 'emptyEtag' });
  const r = await call({ storeFactory: s.storeFactory, ...m });
  assert.equal(r.body.sent, false);
  assert.equal(r.body.reason, 'unconfirmed');
  assert.deepEqual(m.sent, []);
}));

test('FAILS CLOSED: a store error sends no mail (never fall back to an unbounded per-instance send)', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores({ quirk: 'throws' });
  const r = await call({ storeFactory: s.storeFactory, ...m });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, false);
  assert.equal(r.body.reason, 'store_unavailable');
  assert.deepEqual(m.sent, []);
}));

test('a failed mail send is reported, never thrown, and the hour stays claimed (bounded Graph pressure)', () => withEnv(async () => {
  const s = fakeStores();
  let attempts = 0;
  const sendMailImpl = async () => { attempts += 1; throw new Error('graph 429'); };
  const now = () => Date.UTC(2026, 9, 15, 9, 0, 0);
  const a = await call({ storeFactory: s.storeFactory, sendMailImpl, now });
  assert.equal(a.status, 200);
  assert.equal(a.body.reason, 'mail_failed');
  const b = await call({ storeFactory: s.storeFactory, sendMailImpl, now });
  assert.equal(b.body.sent, false);
  assert.equal(attempts, 1, 'a failing Graph must not be retried by every later request in the hour');
}));

test('a hung mail send is cut off by the timeout', () => withEnv(async () => {
  const s = fakeStores();
  const t0 = Date.now();
  const r = await call({ storeFactory: s.storeFactory, sendMailImpl: () => new Promise(() => {}), mailTimeoutMs: 40 });
  assert.equal(r.body.reason, 'mail_failed');
  assert.ok(Date.now() - t0 < 2000);
}));

test('the claim must use set() with onlyIfNew, not setJSON (which silently drops the condition)', () => withEnv(async () => {
  const { handleSignatureAlert } = await load();
  const m = mailer();
  const seen = [];
  const storeFactory = () => ({
    set: async (k, b, o) => { seen.push(['set', o]); return { modified: true, etag: '"x"' }; },
    setJSON: async () => { seen.push(['setJSON']); return { modified: true, etag: '"x"' }; },
  });
  await handleSignatureAlert(req({ token: token() }), { storeFactory, ...m });
  assert.deepEqual(seen, [['set', { onlyIfNew: true }]]);
}));

test('an unknown function name in an otherwise valid token is rejected (allowlist)', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores();
  const r = await call({ storeFactory: s.storeFactory, ...m }, req({ token: token({ fn: '<script>alert(1)</script>' }) }));
  assert.equal(r.status, 400);
  assert.deepEqual(m.sent, []);
}));

test('a missing INTAKE_TOKEN_SECRET fails closed (500) without touching store or mail', () => withEnv(async () => {
  const m = mailer(); const s = fakeStores();
  const r = await call({ storeFactory: s.storeFactory, ...m });
  assert.equal(r.status, 500);
  assert.deepEqual(m.sent, []);
  assert.equal(s.opened.length, 0);
}, { INTAKE_TOKEN_SECRET: undefined }));

// Round-2 review of PR #171 ------------------------------------------------------------------------------
test('a multibyte junk token is a 401, never an uncaught throw (timingSafeEqual used to throw on unequal byte lengths)', () => withEnv(async () => {
  const { handleSignatureAlert } = await load();
  const m = mailer(); const s = fakeStores();
  for (const tokenValue of [`abc.${'é'.repeat(64)}`, `abc.${'😀'.repeat(32)}`, `${'é'.repeat(10)}.${'f'.repeat(64)}`]) {
    const res = await handleSignatureAlert(req({ token: tokenValue }), { storeFactory: s.storeFactory, ...m });
    assert.equal(res.status, 401, tokenValue.slice(0, 12));
  }
  assert.deepEqual(m.sent, []);
  assert.equal(s.opened.length, 0, 'a junk token must not open the store');
}));

test('a hung Blobs claim is cut off and fails closed (no mail), so the hour is not claimed by an abandoned invocation', () => withEnv(async () => {
  const m = mailer();
  const storeFactory = () => ({ set: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await call({ storeFactory, ...m, claimTimeoutMs: 40 });
  assert.equal(r.body.reason, 'store_unavailable');
  assert.deepEqual(m.sent, []);
  assert.ok(Date.now() - t0 < 2000);
}));

test('the Graph fetch used by the mail send carries an AbortSignal (a hung Graph cannot hold the function)', () => withEnv(async () => {
  const { handleSignatureAlert } = await load();
  const s = fakeStores();
  const seen = [];
  const baseFetch = async (url, opts) => { seen.push({ url, signal: opts && opts.signal }); return { ok: true, status: 200 }; };
  const sendMailImpl = async (_msg, { fetchImpl }) => { await fetchImpl('https://graph.example/send', { method: 'POST' }); };
  const res = await handleSignatureAlert(req({ token: token() }), { storeFactory: s.storeFactory, sendMailImpl, fetchImpl: baseFetch });
  assert.equal((await res.json()).sent, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].signal instanceof AbortSignal, 'the wrapped fetch must pass an AbortSignal');
}));

test('the hour bucket is UTC, never the host-local clock (local getters are poisoned for the duration)', () => withEnv(async () => {
  const proto = Date.prototype;
  const saved = {};
  for (const k of ['getHours', 'getDate', 'getMonth', 'getFullYear', 'getDay', 'getTimezoneOffset']) { saved[k] = proto[k]; proto[k] = () => 99; }
  try {
    const m = mailer(); const s = fakeStores();
    const now = () => Date.UTC(2026, 9, 15, 23, 59, 59);
    await call({ storeFactory: s.storeFactory, ...m, now });
    assert.deepEqual([...s.data.keys()], ['sig-alert:alert-2026101523']);
  } finally { Object.assign(proto, saved); }
}));
