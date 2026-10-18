'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { internalFormHeaders, internalFormSignature, config } = require('../../netlify/functions/_shared/internal-forms.js');
const { forwardToNetlifyForm } = require('../../netlify/functions/_shared/netlify-forms.js');

// The two function-only Forms (ledger, failure log) take an unauthenticated POST from anyone. The
// edge guard answers 403 unless the request carries the HMAC our functions add. The edge module is
// ESM and written to be importable from Node, so it is tested here against real Request objects.

const SECRET = 'test-secret-value';
const load = () => import('../../netlify/edge-functions/forms-guard.mjs');
const post = (body, { type = 'application/x-www-form-urlencoded', path = '/', headers = {} } = {}) =>
  new Request(`https://oxfordra.net${path}`, { method: 'POST', body, headers: { 'content-type': type, ...headers } });
const quiet = async (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = w; }
};

test('edge signature matches the one the functions send', async () => {
  const { signature } = await load();
  assert.equal(await signature(SECRET), internalFormSignature(SECRET));
});

test('functions sign posts to the internal forms only, and only when a secret exists', () => {
  const env = { FORMS_INTERNAL_SECRET: SECRET };
  assert.deepEqual(internalFormHeaders('pipeline-failures', env), { [config.header]: internalFormSignature(SECRET) });
  assert.deepEqual(internalFormHeaders('broker-network-ledger', env), { [config.header]: internalFormSignature(SECRET) });
  assert.deepEqual(internalFormHeaders('contact', env), {});
  assert.deepEqual(internalFormHeaders('pipeline-failures', {}), {});
  // The dedicated secret wins; INTAKE_TOKEN_SECRET is the fallback.
  assert.deepEqual(internalFormHeaders('pipeline-failures', { INTAKE_TOKEN_SECRET: 'b', FORMS_INTERNAL_SECRET: 'a' }), { [config.header]: internalFormSignature('a') });
  assert.deepEqual(internalFormHeaders('pipeline-failures', { INTAKE_TOKEN_SECRET: 'b' }), { [config.header]: internalFormSignature('b') });
});

test('forwardToNetlifyForm attaches the signature to internal forms and nothing extra to others', async () => {
  const prev = process.env.FORMS_INTERNAL_SECRET;
  process.env.FORMS_INTERNAL_SECRET = SECRET;
  try {
    const seen = [];
    const fetchImpl = async (url, opts) => { seen.push(opts.headers); return { ok: true, status: 200 }; };
    await forwardToNetlifyForm('https://oxfordra.net', 'broker-network-ledger', { a: 1 }, { fetchImpl });
    await forwardToNetlifyForm('https://oxfordra.net', 'chat-lead', { a: 1 }, { fetchImpl });
    assert.equal(seen[0][config.header], internalFormSignature(SECRET));
    assert.equal(seen[1][config.header], undefined);
  } finally {
    if (prev === undefined) delete process.env.FORMS_INTERNAL_SECRET; else process.env.FORMS_INTERNAL_SECRET = prev;
  }
});

test('rejects unsigned POSTs that name an internal form, however the name is spelled or carried', () => quiet(async () => {
  const { guard } = await load();
  const forged = [
    post('form-name=broker-network-ledger&name=x'),
    post('form-name=pipeline-failures&detail=x', { path: '/contact' }),
    post('form%2Dname=pipeline%2Dfailures'),
    post('form-name=%70ipeline-failures&detail=forged&x=%FF'),
    post('form-name=pipeline-failures&x=%ZZ&y=%'),
    post('form-name=Pipeline-Failures'),
    post('{"form-name":"pipeline-failures"}', { type: 'application/json' }),
    post('--b\r\nContent-Disposition: form-data; name="form-name"\r\n\r\nbroker-network-ledger\r\n--b--', { type: 'multipart/form-data; boundary=b' }),
    new Request('https://oxfordra.net/?form-name=pipeline-failures', { method: 'POST', body: 'x' }),
    post('form-name=pipeline-failures', { headers: { [config.header]: 'wrong' } }),
    post('form-name=pipeline-failures', { headers: { [config.header]: 'x'.repeat(64) } }),
  ];
  for (const req of forged) {
    const res = await guard(req, { secret: SECRET });
    assert.ok(res && res.status === 403, `${req.url} was not rejected`);
  }
}));

test('lets signed internal POSTs and every other form through', async () => {
  const { guard } = await load();
  const sig = internalFormSignature(SECRET);
  assert.equal(await guard(post('form-name=pipeline-failures', { headers: { [config.header]: sig } }), { secret: SECRET }), null);
  assert.equal(await guard(post('form-name=broker-network-ledger', { headers: { [config.header]: sig } }), { secret: SECRET }), null);
  assert.equal(await guard(post('form-name=contact&name=Bob&message=hello'), { secret: SECRET }), null);
  assert.equal(await guard(post('form-name=commercial-lease-application', { path: '/application-received' }), { secret: SECRET }), null);
  assert.equal(await guard(new Request('https://oxfordra.net/', { method: 'GET' }), { secret: SECRET }), null);
  assert.equal(await guard(new Request('https://oxfordra.net/contact', { method: 'POST' }), { secret: SECRET }), null);
});

test('fails open (and warns) only when no secret is configured', () => quiet(async () => {
  const { guard } = await load();
  assert.equal(await guard(post('form-name=pipeline-failures'), { secret: '' }), null);
}));

test('oversize bodies: 413 anywhere but multipart on the attachment form, which is scanned to the end', () => quiet(async () => {
  const { guard } = await load();
  const filler = 'a'.repeat(1024 * 1024 + 10);
  assert.equal((await guard(post(`${filler}&x=1`), { secret: SECRET })).status, 413);
  assert.equal((await guard(post(`f=${filler}&form-name=pipeline-failures`, { path: '/application-received' }), { secret: SECRET })).status, 413);
  assert.equal((await guard(post(`${filler}`, { type: 'multipart/form-data; boundary=b', path: '/contact' }), { secret: SECRET })).status, 413);
  const mp = (parts) => `--b\r\n${parts.join('\r\n--b\r\n')}\r\n--b--`;
  const field = (n, v) => `Content-Disposition: form-data; name="${n}"\r\n\r\n${v}`;
  const opts = { type: 'multipart/form-data; boundary=b', path: '/application-received' };
  const clean = mp([field('form-name', 'commercial-lease-application'), field('file', filler)]);
  assert.equal(await guard(post(clean, opts), { secret: SECRET }), null);
  // The name AFTER the first MiB, including one straddling a chunk boundary, is still caught.
  const late = mp([field('file', filler), field('form-name', 'broker-network-ledger')]);
  assert.equal((await guard(post(late, opts), { secret: SECRET })).status, 403);
  const enc = new TextEncoder().encode(late);
  const split = late.indexOf('broker-network-ledger') + 7;
  const stream = new ReadableStream({ start(c) { c.enqueue(enc.subarray(0, split)); c.enqueue(enc.subarray(split)); c.close(); } });
  const chunked = new Request('https://oxfordra.net/application-received', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': opts.type } });
  assert.equal((await guard(chunked, { secret: SECRET })).status, 403);
  const body = new Request('https://oxfordra.net/application-received', { method: 'POST', body: clean, headers: { 'content-type': opts.type } });
  assert.equal(await guard(body, { secret: SECRET }), null);
  assert.equal((await body.text()).length, clean.length, 'the original body must still be readable after the guard passes it');
}));

test('large multipart: a name straddling exactly 1 MiB, an encoded late part, a boundary-less type and CPU cost', () => quiet(async () => {
  const { guard } = await load();
  const MIB = 1024 * 1024;
  const opts = { path: '/application-received', headers: { 'content-type': 'multipart/form-data; boundary=b' } };
  const chunked = (str, size, o = opts) => {
    const bytes = new TextEncoder().encode(str);
    let at = 0;
    const stream = new ReadableStream({ pull(c) { if (at >= bytes.length) return c.close(); c.enqueue(bytes.subarray(at, at + size)); at += size; } });
    return new Request(`https://oxfordra.net${o.path}`, { method: 'POST', body: stream, duplex: 'half', headers: o.headers });
  };
  const head = '--b\r\nContent-Disposition: form-data; name="f"\r\n\r\n';
  const name = 'broker-network-ledger';
  // The 1 MiB mark falls mid-name, with chunk sizes that divide 1 MiB exactly.
  const pad = 'a'.repeat(MIB - head.length - 6);
  const split = `${head}${pad}${name}\r\n--b--`;
  for (const size of [65536, 16384, 4096, 1000]) {
    assert.equal((await guard(chunked(split, size), { secret: SECRET })).status, 403, `chunk ${size}`);
  }
  const lateEnc = `${head}${'a'.repeat(MIB + 5)}\r\n--b\r\nContent-Disposition: form-data; name="form-name"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\npipeline=2Dfailures\r\n--b--`;
  assert.equal((await guard(chunked(lateEnc, 65536), { secret: SECRET })).status, 415);
  const noBoundary = { path: '/application-received', headers: { 'content-type': 'multipart/form-data' } };
  assert.equal((await guard(chunked(`x=${'a'.repeat(MIB + 5)}`, 65536, noBoundary), { secret: SECRET })).status, 413);
  // Worst-case CPU for the 1 MiB prefix scan stays far below the edge budget.
  const worst = `x=${'%41'.repeat(349000)}`;
  const t = performance.now();
  await guard(post(worst), { secret: SECRET });
  assert.ok(performance.now() - t < 40, `prefix scan took ${performance.now() - t} ms`);
}));

test('refuses encodings the platform parser might undo', () => quiet(async () => {
  const { guard } = await load();
  const qp = '--b\r\nContent-Disposition: form-data; name="form-name"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\npipeline=2Dfailures\r\n--b--';
  assert.equal((await guard(post(qp, { type: 'multipart/form-data; boundary=b' }), { secret: SECRET })).status, 415);
  assert.equal((await guard(post('form-name=x', { headers: { 'content-encoding': 'gzip' } }), { secret: SECRET })).status, 415);
}));

test('edge config: POST only, all paths except platform and chat routes, bypass on error', async () => {
  const { config: cfg } = await load();
  assert.equal(cfg.method, 'POST');
  assert.equal(cfg.path, '/*');
  assert.deepEqual(cfg.excludedPath, ['/.netlify/*', '/api/chat', '/api/broker-upload-session', '/api/broker-finalize', '/api/broker-score-status']);
  assert.equal(cfg.onError, 'bypass');
});
