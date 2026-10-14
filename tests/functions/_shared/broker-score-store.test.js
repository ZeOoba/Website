'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// broker-score-store is ESM so Netlify's esbuild bundles @netlify/blobs into the
// function; as CommonJS reached from an ESM entry it left an unresolvable
// runtime require (verified broken on deploy-preview-72). Load it lazily and
// delegate, so every assertion below stays unchanged.
let storeModulePromise;
function loadStore() {
  storeModulePromise ||= import(
    pathToFileURL(path.join(__dirname, '..', '..', '..', 'netlify', 'functions', '_shared', 'broker-score-store.mjs')).href
  );
  return storeModulePromise;
}
const bind = (name) => (...args) => loadStore().then((m) => m[name](...args));
const writeScoreResult = bind('writeScoreResult');
const readScoreResult = bind('readScoreResult');
const hasBeenScored = bind('hasBeenScored');
const markScored = bind('markScored');
const checkAndRecordRateLimit = bind('checkAndRecordRateLimit');
const checkAndRecordDailyCap = bind('checkAndRecordDailyCap');

// A tiny in-memory fake matching @netlify/blobs's getStore(name) -> {setJSON,get,delete} shape.
function fakeStoreFactory() {
  const data = new Map();
  return function getStore(name) {
    const ns = name;
    return {
      async setJSON(key, value) { data.set(`${ns}:${key}`, value); },
      async get(key, { type } = {}) { return data.has(`${ns}:${key}`) ? data.get(`${ns}:${key}`) : null; },
      async delete(key) { data.delete(`${ns}:${key}`); },
    };
  };
}

test('writeScoreResult then readScoreResult round-trips the result', async () => {
  const storeFactory = fakeStoreFactory();
  await writeScoreResult('sub-1', { status: 'ready', finalScore: 82 }, { storeFactory });
  const result = await readScoreResult('sub-1', { storeFactory });
  assert.equal(result.status, 'ready');
  assert.equal(result.finalScore, 82);
});

test('readScoreResult returns null for an unknown submissionId', async () => {
  const storeFactory = fakeStoreFactory();
  const result = await readScoreResult('nonexistent', { storeFactory });
  assert.equal(result, null);
});

test('readScoreResult returns null and deletes an expired entry', async () => {
  const storeFactory = fakeStoreFactory();
  await writeScoreResult('sub-2', { status: 'ready', finalScore: 50 }, { storeFactory });
  // Manually force expiry by writing an already-past expiresAt directly.
  const store = storeFactory('broker-score-results');
  const stored = await store.get('sub-2', { type: 'json' });
  await store.setJSON('sub-2', { ...stored, expiresAt: Date.now() - 1000 });
  const result = await readScoreResult('sub-2', { storeFactory });
  assert.equal(result, null);
});

test('hasBeenScored is false before markScored and true after', async () => {
  const storeFactory = fakeStoreFactory();
  assert.equal(await hasBeenScored('Broker Submissions/x/om.pdf', { storeFactory }), false);
  await markScored('Broker Submissions/x/om.pdf', { storeFactory });
  assert.equal(await hasBeenScored('Broker Submissions/x/om.pdf', { storeFactory }), true);
});

test('checkAndRecordRateLimit allows up to the per-IP cap then blocks', async () => {
  const storeFactory = fakeStoreFactory();
  for (let i = 0; i < 5; i++) {
    const r = await checkAndRecordRateLimit('1.2.3.4', { storeFactory });
    assert.equal(r.allowed, true);
  }
  const blocked = await checkAndRecordRateLimit('1.2.3.4', { storeFactory });
  assert.equal(blocked.allowed, false);
});

test('checkAndRecordRateLimit tracks each IP independently', async () => {
  const storeFactory = fakeStoreFactory();
  for (let i = 0; i < 5; i++) await checkAndRecordRateLimit('1.1.1.1', { storeFactory });
  const otherIp = await checkAndRecordRateLimit('2.2.2.2', { storeFactory });
  assert.equal(otherIp.allowed, true);
});

test('checkAndRecordDailyCap allows up to the daily cap then blocks', async () => {
  const storeFactory = fakeStoreFactory();
  for (let i = 0; i < 50; i++) {
    const r = await checkAndRecordDailyCap({ storeFactory });
    assert.equal(r.allowed, true);
  }
  const blocked = await checkAndRecordDailyCap({ storeFactory });
  assert.equal(blocked.allowed, false);
});

// ---------------------------------------------------------------------------
// Single-use intake tokens (consumeIntakeToken). The old implementation was a
// read-then-write on an eventually-consistent store: N concurrent finalizes with
// ONE token all read "absent" and all returned first:true, so one reCAPTCHA
// solve produced N ledger rows and 2N emails (adversarial review of PR #166).
// The fake below models the real store: network latency on every call, and
// conditional writes (onlyIfNew / onlyIfMatch) that are atomic server-side.
// ---------------------------------------------------------------------------
const consumeIntakeToken = bind('consumeIntakeToken');
const releaseIntakeToken = bind('releaseIntakeToken');

function fakeConditionalStoreFactory({ latencyMs = 15 } = {}) {
  const data = new Map(); // `${ns}:${key}` -> { value, etag }
  let etagSeq = 0;
  const tick = () => new Promise((r) => setTimeout(r, latencyMs));
  const factory = function getStore(arg) {
    const ns = typeof arg === 'string' ? arg : arg.name;
    const k = (key) => `${ns}:${key}`;
    // Faithful to @netlify/blobs 10.7.9: set() honors onlyIfNew/onlyIfMatch (sends If-None-Match /
    // If-Match), but setJSON() DROPS them. A regression to setJSON must therefore fail the race test.
    const write = async (key, text, opts) => {
      await tick();
      // The check-and-set below has no await between them: atomic, like the server.
      const cur = data.get(k(key));
      if (opts.onlyIfNew && cur) return { modified: false };
      if (opts.onlyIfMatch !== undefined && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = `e${++etagSeq}`;
      data.set(k(key), { value: JSON.parse(text), etag });
      return { modified: true, etag };
    };
    return {
      async set(key, text, opts = {}) { return write(key, text, opts); },
      async setJSON(key, value) { return write(key, JSON.stringify(value), {}); },
      async get(key) { await tick(); const cur = data.get(k(key)); return cur ? cur.value : null; },
      async getWithMetadata(key) { await tick(); const cur = data.get(k(key)); return cur ? { data: cur.value, etag: cur.etag, metadata: {} } : null; },
      async delete(key) { await tick(); data.delete(k(key)); },
    };
  };
  factory.raw = data;
  return factory;
}

test('consumeIntakeToken: exactly one of N CONCURRENT callers with the same token is first (race)', async () => {
  const storeFactory = fakeConditionalStoreFactory();
  const results = await Promise.all(Array.from({ length: 10 }, () => consumeIntakeToken('Broker Submissions/x/om.pdf', { storeFactory })));
  assert.equal(results.filter((r) => r.first).length, 1, `10 concurrent consumes of one token must yield exactly one first:true, got ${results.map((r) => r.first)}`);
});

test('consumeIntakeToken: sequential replay is rejected, and distinct tokens do not interfere', async () => {
  const storeFactory = fakeConditionalStoreFactory({ latencyMs: 0 });
  assert.deepEqual(await consumeIntakeToken('a', { storeFactory }), { first: true });
  assert.deepEqual(await consumeIntakeToken('a', { storeFactory }), { first: false });
  assert.deepEqual(await consumeIntakeToken('b', { storeFactory }), { first: true });
});

test('consumeIntakeToken: an expired consumed-marker is replaced atomically (exactly one concurrent winner)', async () => {
  const storeFactory = fakeConditionalStoreFactory();
  storeFactory.raw.set('broker-intake-consumed:old', { value: { consumedAt: 1, expiresAt: Date.now() - 1000 }, etag: 'stale' });
  const results = await Promise.all(Array.from({ length: 8 }, () => consumeIntakeToken('old', { storeFactory })));
  assert.equal(results.filter((r) => r.first).length, 1, 'expired marker: only one concurrent caller may re-consume it');
});

test('releaseIntakeToken lets the same token be consumed again (email-failure retry path)', async () => {
  const storeFactory = fakeConditionalStoreFactory({ latencyMs: 0 });
  assert.equal((await consumeIntakeToken('r', { storeFactory })).first, true);
  await releaseIntakeToken('r', { storeFactory });
  assert.equal((await consumeIntakeToken('r', { storeFactory })).first, true);
});

// Wire-level contract against the REAL @netlify/blobs client (only fetch is faked). The in-memory fake
// above can only prove the logic; this proves the condition actually reaches the server, which is what
// makes the burn atomic. 10.7.9's setJSON silently drops the condition; set() sends it.
function realClientFactory(respond) {
  const { getStore } = require('@netlify/blobs');
  const requests = [];
  const fetch = async (url, init = {}) => {
    const h = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method: String(init.method || 'GET').toUpperCase(), headers: h };
    requests.push(req);
    return respond(req, requests.length);
  };
  const storeFactory = (name) => getStore({ name, siteID: 'site', token: 'tok', edgeURL: 'http://edge.test', fetch });
  return { storeFactory, requests };
}

test('consumeIntakeToken sends If-None-Match: * on the wire, and a 412 means a replay (real client)', async () => {
  const { storeFactory, requests } = realClientFactory((req, n) => (n === 1
    ? new Response(null, { status: 200, headers: { etag: '"v1"' } })
    : n === 2 ? new Response(null, { status: 412 })
      : new Response(JSON.stringify({ consumedAt: Date.now(), expiresAt: Date.now() + 60_000 }), { status: 200, headers: { etag: '"v1"' } })));
  assert.deepEqual(await consumeIntakeToken('wire-1', { storeFactory }), { first: true });
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].headers['if-none-match'], '*', 'the create-only condition must reach the server (setJSON would drop it)');
  assert.deepEqual(await consumeIntakeToken('wire-1', { storeFactory }), { first: false }, '412 then a live marker is a replay');
});

test('consumeIntakeToken takes over an expired marker with If-Match on the wire (real client)', async () => {
  const { storeFactory, requests } = realClientFactory((req, n) => (n === 1
    ? new Response(null, { status: 412 })
    : n === 2 ? new Response(JSON.stringify({ consumedAt: 1, expiresAt: Date.now() - 1000 }), { status: 200, headers: { etag: '"old"' } })
      : new Response(null, { status: 200, headers: { etag: '"new"' } })));
  assert.deepEqual(await consumeIntakeToken('wire-2', { storeFactory }), { first: true });
  assert.equal(requests[2].method, 'PUT');
  assert.equal(requests[2].headers['if-match'], '"old"', 'takeover must be etag-guarded so only one concurrent caller wins');
});

test('consumeIntakeToken throws (so the caller fails open AND logs) if the store cannot report `modified`', async () => {
  const bad = () => ({ async set() { return undefined; }, async getWithMetadata() { return null; } });
  await assert.rejects(() => consumeIntakeToken('x', { storeFactory: bad }), /did not report `modified`/);
});
