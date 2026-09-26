'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureFolder, uploadSmallFile, createUploadSession, getItemByPath, getFileContent, sanitizeSegment } = require('../../../netlify/functions/_shared/graph-files.js');

// The 120-char cap used to truncate blindly, so a long upload name lost its
// ".pdf" and broker-scoring-run.mjs later read the stored path's extension as
// unsupported — the broker silently got no score (2026-09-25 audit).
test('sanitizeSegment keeps the file extension when it truncates a long name', () => {
  const long = `${'a'.repeat(150)}.pdf`;
  const out = sanitizeSegment(long);
  assert.ok(out.length <= 120, `still ${out.length} chars`);
  assert.ok(out.endsWith('.pdf'), `extension lost: ${out.slice(-10)}`);
  assert.equal(sanitizeSegment('om.pdf'), 'om.pdf');
  assert.equal(sanitizeSegment('a/b:c*d?e"f<g>h|i.xlsx'), 'a-b-c-d-e-f-g-h-i.xlsx');
  assert.equal(sanitizeSegment(''), 'untitled');
});

function withDriveId(fn) {
  const prev = process.env.GRAPH_DRIVE_ID;
  process.env.GRAPH_DRIVE_ID = 'drive-1';
  return Promise.resolve(fn()).finally(() => { process.env.GRAPH_DRIVE_ID = prev; });
}

test('ensureFolder walks each path segment, creating only missing ones', () => withDriveId(async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (url.includes('/root:/Tenant%20Applications') && !url.includes('children')) {
      return { status: 404, ok: false, json: async () => ({}) };
    }
    if (url.includes('/root:/2026-07-10_Doe') && !url.includes('children')) {
      return { status: 404, ok: false, json: async () => ({}) };
    }
    if (url.endsWith(':/children')) {
      return { status: 201, ok: true, json: async () => ({ id: 'x' }) };
    }
    return { status: 200, ok: true, json: async () => ({ id: 'existing' }) };
  };
  const result = await ensureFolder('Tenant Applications/2026-07-10_Doe', { fetchImpl, token: 'tok' });
  assert.equal(result, 'Tenant Applications/2026-07-10_Doe');
  assert.ok(calls.some((c) => c.method === 'POST'), 'must POST to create a missing segment');
}));

test('ensureFolder reuses an existing folder without creating it (idempotent)', () => withDriveId(async () => {
  let postCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST') postCalls += 1;
    return { status: 200, ok: true, json: async () => ({ id: 'already-there' }) };
  };
  await ensureFolder('Broker Submissions/2026-07-10_Acme', { fetchImpl, token: 'tok' });
  assert.equal(postCalls, 0, 'must not create a folder that already exists');
}));

test('uploadSmallFile PUTs raw bytes to the content endpoint', () => withDriveId(async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, 'PUT');
    assert.match(url, /:\/content$/);
    return { ok: true, status: 200, json: async () => ({ webUrl: 'https://contoso.sharepoint.com/x/file.pdf', id: 'item-1' }) };
  };
  const result = await uploadSmallFile('Tenant Applications/x', 'credit-report.pdf', Buffer.from('bytes'), { fetchImpl, token: 'tok' });
  assert.equal(result.webUrl, 'https://contoso.sharepoint.com/x/file.pdf');
}));

test('uploadSmallFile throws with the status code on failure', () => withDriveId(async () => {
  const fetchImpl = async () => ({ ok: false, status: 507, json: async () => ({}) });
  await assert.rejects(() => uploadSmallFile('p', 'f.pdf', Buffer.from('x'), { fetchImpl, token: 'tok' }), /\(507\)/);
}));

test('createUploadSession posts and returns the uploadUrl', () => withDriveId(async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.match(url, /:\/createUploadSession$/);
    return { ok: true, status: 200, json: async () => ({ uploadUrl: 'https://contoso.sharepoint.com/upload/session-1', expirationDateTime: '2026-07-11T00:00:00Z' }) };
  };
  const result = await createUploadSession('Broker Submissions/x', 'om.pdf', 30_000_000, { fetchImpl, token: 'tok' });
  assert.equal(result.uploadUrl, 'https://contoso.sharepoint.com/upload/session-1');
}));

test('getItemByPath returns null on 404 and the item on 200', () => withDriveId(async () => {
  const notFound = await getItemByPath('nope', { fetchImpl: async () => ({ status: 404, ok: false }), token: 'tok' });
  assert.equal(notFound, null);
  const found = await getItemByPath('yes', { fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ id: 'i' }) }), token: 'tok' });
  assert.deepEqual(found, { id: 'i' });
}));

test('getFileContent returns the file bytes as a Buffer', () => withDriveId(async () => {
  const fetchImpl = async (url) => {
    if (url.includes(':/content')) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('hello world').buffer };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const buf = await getFileContent('Broker Submissions/x/om.pdf', { fetchImpl, token: 'tok' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf8'), 'hello world');
}));

test('getFileContent returns null for a 404', () => withDriveId(async () => {
  const fetchImpl = async (url) => {
    if (url.includes(':/content')) return { ok: false, status: 404 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const buf = await getFileContent('Broker Submissions/x/missing.pdf', { fetchImpl, token: 'tok' });
  assert.equal(buf, null);
}));
