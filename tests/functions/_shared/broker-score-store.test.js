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

// There is deliberately NO takeover of an expired marker. It would need an If-Match replace, which the live
// Netlify Blobs service does not make atomic under contention (probe 2026-10-15: 20 concurrent holders of one etag,
// 8 to 13 succeeded), and it is unreachable anyway (marker 24 h vs intake token 15 min, unique per-session key).
// So ANY existing marker, live or expired, is a replay, and nobody can win it concurrently.
test('consumeIntakeToken: an EXPIRED marker is a replay for every concurrent caller (no takeover, nobody wins)', async () => {
  const storeFactory = fakeConditionalStoreFactory();
  storeFactory.raw.set('broker-intake-consumed:old', { value: { consumedAt: 1, expiresAt: Date.now() - 1000 }, etag: 'stale' });
  const results = await Promise.all(Array.from({ length: 8 }, () => consumeIntakeToken('old', { storeFactory })));
  assert.equal(results.filter((r) => r.first).length, 0, 'an expired marker must never hand the token to anyone');
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
    const req = { method: String(init.method || 'GET').toUpperCase(), headers: h, body: typeof init.body === 'string' ? init.body : '' };
    requests.push(req);
    return respond(req, requests.length, requests);
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

test('consumeIntakeToken NEVER sends an If-Match replace: an expired marker with an etag is a replay (real client)', async () => {
  const { storeFactory, requests } = realClientFactory((req, n) => (n === 1
    ? new Response(null, { status: 412 })
    : new Response(JSON.stringify({ consumedAt: 1, expiresAt: Date.now() - 1000 }), { status: 200, headers: { etag: '"old"' } })));
  assert.deepEqual(await consumeIntakeToken('wire-2', { storeFactory }), { first: false });
  assert.equal(requests.filter((r) => r.method === 'PUT').length, 1, 'only the create-only attempt may be written');
  assert.ok(requests.every((r) => r.headers['if-match'] === undefined), 'no request may carry If-Match (not atomic under contention)');
});

// The REAL client reports {modified:true, etag:''} for every non-412 status (401/403/404/409 ...), so a
// failed write looks like a win. These pin that a store outage / auth failure throws (and so reaches the
// caller's logged fail-open path) instead of silently disabling replay protection.
// (429/500 are avoided on purpose: the client retries those for ~25 s.)
test('consumeIntakeToken throws when the create-only PUT is rejected (403) and the marker is absent (real client)', async () => {
  const { storeFactory } = realClientFactory((req) => (req.method === 'PUT' ? new Response(null, { status: 403 }) : new Response(null, { status: 404 })));
  await assert.rejects(() => consumeIntakeToken('fail-403', { storeFactory }), /no live marker is stored/);
});

test('consumeIntakeToken throws when the store is unreachable for both the write and the read-back (real client)', async () => {
  const { storeFactory } = realClientFactory(() => new Response(null, { status: 401 }));
  await assert.rejects(() => consumeIntakeToken('fail-401', { storeFactory }));
});

// Reads back the nonce this caller wrote, as the real server would store it.
const ourMarker = (requests) => {
  const put = [...requests].reverse().find((r) => r.method === 'PUT' && r.body);
  return put ? put.body : '{}';
};
const otherLiveMarker = () => JSON.stringify({ nonce: 'someone-else', consumedAt: Date.now(), expiresAt: Date.now() + 60_000 });

test('consumeIntakeToken still wins when a genuine success carries no etag but OUR marker reads back (real client)', async () => {
  const { storeFactory } = realClientFactory((req, n, requests) => (req.method === 'PUT'
    ? new Response(null, { status: 200 })
    : new Response(ourMarker(requests), { status: 200 })));
  assert.deepEqual(await consumeIntakeToken('no-etag-ok', { storeFactory }), { first: true });
});

// Round-2 review of PR #167: when the conditional PUT fails with a non-412 status the client still says
// {modified:true, etag:''}. If a marker ALREADY exists (a replay, or a concurrent winner), reading it back
// must be a REPLAY (first:false), never a win and never a throw (a throw fails open and lets it through).
for (const status of [400, 401, 403, 404, 409]) {
  test(`a replay whose PUT fails with ${status} but a live marker exists is first:false, not a win (real client)`, async () => {
    const { storeFactory } = realClientFactory((req) => (req.method === 'PUT'
      ? new Response(null, { status })
      : new Response(otherLiveMarker(), { status: 200, headers: { etag: '"w"' } })));
    assert.deepEqual(await consumeIntakeToken(`replay-${status}`, { storeFactory }), { first: false });
  });
}

test('a concurrent LOSER whose PUT returns 409 sees the winner\'s marker and loses (exactly one winner, real client)', async () => {
  // Winner: normal success. Loser: its PUT is answered 409 and the read-back finds the winner's marker.
  const winner = realClientFactory((req, n, requests) => (req.method === 'PUT' ? new Response(null, { status: 200, headers: { etag: '"w"' } }) : new Response(ourMarker(requests), { status: 200 })));
  const loser = realClientFactory((req) => (req.method === 'PUT' ? new Response(null, { status: 409 }) : new Response(otherLiveMarker(), { status: 200 })));
  const results = await Promise.all([
    consumeIntakeToken('contended', { storeFactory: winner.storeFactory }),
    consumeIntakeToken('contended', { storeFactory: loser.storeFactory }),
  ]);
  assert.deepEqual(results.map((r) => r.first), [true, false]);
});

test('a winner whose retried PUT gets a 412 still wins when the stored marker is its own (zero-winner case, real client)', async () => {
  // First attempt committed but its response was lost; the client's retry gets 412. The marker holds OUR nonce.
  const { storeFactory } = realClientFactory((req, n, requests) => (req.method === 'PUT'
    ? new Response(null, { status: 412 })
    : new Response(ourMarker(requests), { status: 200, headers: { etag: '"mine"' } })));
  assert.deepEqual(await consumeIntakeToken('lost-ack', { storeFactory }), { first: true });
});

// Round-3 review of PR #167: a 412 PROVES a marker exists. If the (eventually consistent) read right
// after it lags and returns 404, that must be a replay, never a throw: a throw fails open and lets the
// replay through. 35e1b0d returned first:false here; ccfb478 regressed it to a throw.
test('an authoritative 412 followed by a lagging 404 read is first:false, never a fail-open throw (real client)', async () => {
  const { storeFactory } = realClientFactory((req) => (req.method === 'PUT' ? new Response(null, { status: 412 }) : new Response(null, { status: 404 })));
  assert.deepEqual(await consumeIntakeToken('lagging-read', { storeFactory }), { first: false });
});

// Round-4 review of PR #167: the 412 fix covered only the result of resolve(). Once the server has
// authoritatively said a marker exists, ANY later fault (a read 401/403/5xx, unparseable marker JSON, a failed
// follow-up write) must be a replay, not a throw: a throw fails open and lets the replay through.
for (const status of [401, 403]) {
  test(`a 412 followed by a read that fails ${status} is first:false, never a fail-open throw (real client)`, async () => {
    const { storeFactory } = realClientFactory((req) => (req.method === 'PUT' ? new Response(null, { status: 412 }) : new Response(null, { status })));
    assert.deepEqual(await consumeIntakeToken(`post412-read-${status}`, { storeFactory }), { first: false });
  });
}

test('a 412 followed by an unparseable marker body is first:false, never a fail-open throw (real client)', async () => {
  const { storeFactory } = realClientFactory((req) => (req.method === 'PUT' ? new Response(null, { status: 412 }) : new Response('{bad', { status: 200 })));
  assert.deepEqual(await consumeIntakeToken('post412-badjson', { storeFactory }), { first: false });
});

test('a 412, a lagging 404, then a failed retry write (409) and a second 404 is first:false, never a throw (real client)', async () => {
  const { storeFactory } = realClientFactory((req, n) => (req.method === 'PUT'
    ? new Response(null, { status: n === 1 ? 412 : 409 })
    : new Response(null, { status: 404 })));
  assert.deepEqual(await consumeIntakeToken('post412-retry-409', { storeFactory }), { first: false });
});

test('a fault BEFORE any 412 still throws (so the caller fails open AND logs): nothing is known yet (real client)', async () => {
  const { storeFactory } = realClientFactory(() => new Response(null, { status: 403 }));
  await assert.rejects(() => consumeIntakeToken('pre412-403', { storeFactory }));
});

test('a marker that vanishes between the 412 and the read (released) is re-created: the onlyIfNew retry wins (real client)', async () => {
  const { storeFactory, requests } = realClientFactory((req, n) => (n === 1 ? new Response(null, { status: 412 })
    : n === 2 ? new Response(null, { status: 404 })
      : new Response(null, { status: 200, headers: { etag: '"fresh"' } })));
  assert.deepEqual(await consumeIntakeToken('vanished', { storeFactory }), { first: true });
  assert.deepEqual(requests.map((r) => r.method), ['PUT', 'GET', 'PUT']);
  assert.equal(requests[2].headers['if-none-match'], '*');
});

test('a marker written by the old code (no nonce) is still honored as a live replay (real client)', async () => {
  const legacy = JSON.stringify({ consumedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const { storeFactory } = realClientFactory((req) => (req.method === 'PUT'
    ? new Response(null, { status: 412 })
    : new Response(legacy, { status: 200, headers: { etag: '"old"' } })));
  assert.deepEqual(await consumeIntakeToken('legacy', { storeFactory }), { first: false });
});

test('consumeIntakeToken: an expired marker with no etag is a replay and is NOT overwritten (real client)', async () => {
  const puts = [];
  const { storeFactory } = realClientFactory((req, n) => {
    if (req.method === 'PUT') { puts.push(req); return n === 1 ? new Response(null, { status: 412 }) : new Response(null, { status: 200, headers: { etag: '"x"' } }); }
    return new Response(JSON.stringify({ consumedAt: 1, expiresAt: Date.now() - 1000 }), { status: 200 }); // no etag header
  });
  assert.deepEqual(await consumeIntakeToken('no-etag-takeover', { storeFactory }), { first: false });
  assert.equal(puts.length, 1, 'no unconditional overwrite may be attempted');
});

test('consumeIntakeToken throws (so the caller fails open AND logs) if the store cannot report `modified`', async () => {
  const bad = () => ({ async set() { return undefined; }, async getWithMetadata() { return null; } });
  await assert.rejects(() => consumeIntakeToken('x', { storeFactory: bad }), /did not report `modified`/);
});
