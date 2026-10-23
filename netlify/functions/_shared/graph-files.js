'use strict';
const { getGraphToken } = require('./graph-auth.js');
const { UPLOAD_PATH_RE } = require('./validate.js');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`graph-files: missing ${name}`);
  return v;
}

// 120 chars is the cap we impose on a single path segment. Truncate the STEM,
// never the extension: broker-scoring-run.mjs derives the file type from the
// stored path, so a blind slice that cut ".pdf" off a long name silently
// produced unsupported_file_type and the broker got no score.
const MAX_SEGMENT = 120;
function sanitizeSegment(segment) {
  const clean = String(segment).replace(/[\\/:*?"<>|]/g, '-').trim();
  if (clean.length <= MAX_SEGMENT) return clean || 'untitled';
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return (clean.slice(0, MAX_SEGMENT - ext.length).trim() + ext) || 'untitled';
}

function encodeGraphPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function graphFetch(path, { method = 'GET', headers = {}, body, fetchImpl = fetch, token } = {}) {
  const authToken = token || (await getGraphToken({ fetchImpl }));
  return fetchImpl(`${GRAPH_BASE}${path}`, { method, headers: { authorization: `Bearer ${authToken}`, ...headers }, body });
}

async function ensureFolder(folderPath, opts = {}) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const segments = folderPath.split('/').filter(Boolean).map(sanitizeSegment);
  let parentPath = '';
  for (const segment of segments) {
    const childPath = parentPath ? `${parentPath}/${segment}` : segment;
    const getRes = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(childPath)}`, opts);
    if (getRes.status === 200) {
      parentPath = childPath;
      continue;
    }
    if (getRes.status !== 404) {
      throw new Error(`graph-files: ensureFolder lookup failed at "${childPath}" (${getRes.status})`);
    }
    const parentSegment = parentPath ? `/drives/${driveId}/root:/${encodeGraphPath(parentPath)}:/children` : `/drives/${driveId}/root/children`;
    const createRes = await graphFetch(parentSegment, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: segment, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      ...opts,
    });
    if (!createRes.ok) {
      throw new Error(`graph-files: ensureFolder create failed at "${childPath}" (${createRes.status})`);
    }
    parentPath = childPath;
  }
  return parentPath;
}

async function uploadSmallFile(folderPath, fileName, buffer, opts = {}) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const itemPath = `${folderPath}/${sanitizeSegment(fileName)}`;
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(itemPath)}:/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: buffer,
    ...opts,
  });
  if (!res.ok) throw new Error(`graph-files: uploadSmallFile failed for "${itemPath}" (${res.status})`);
  const json = await res.json();
  return { webUrl: json.webUrl, id: json.id, path: itemPath };
}

async function createUploadSession(folderPath, fileName, fileSizeBytes, opts = {}) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const safeName = sanitizeSegment(fileName);
  const itemPath = `${folderPath}/${safeName}`;
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(itemPath)}:/createUploadSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: safeName } }),
    ...opts,
  });
  if (!res.ok) throw new Error(`graph-files: createUploadSession failed for "${itemPath}" (${res.status})`);
  const json = await res.json();
  return { uploadUrl: json.uploadUrl, expirationDateTime: json.expirationDateTime, path: itemPath };
}

async function getItemByPath(itemPath, opts = {}) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(itemPath)}`, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`graph-files: getItemByPath failed for "${itemPath}" (${res.status})`);
  return res.json();
}

// Reads at most `max` bytes of a fetch Response body. Streams when it can and cancels the rest, so a
// server that ignores a Range header (or a file larger than the cap) is never fully buffered.
async function readUpTo(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let exceeded = false;
    while (total <= max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
    if (total > max) { exceeded = true; await reader.cancel().catch(() => {}); }
    return { buffer: Buffer.concat(chunks).subarray(0, max), exceeded };
  }
  const all = Buffer.from(await res.arrayBuffer());
  return { buffer: all.subarray(0, max), exceeded: all.length > max };
}

// Only the first `bytes` bytes (for magic-number checks). Null when the item does not exist.
async function getFileHead(itemPath, bytes, opts = {}) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(itemPath)}:/content`, {
    ...opts,
    headers: { range: `bytes=0-${bytes - 1}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`graph-files: getFileHead failed for "${itemPath}" (${res.status})`);
  return (await readUpTo(res, bytes)).buffer;
}

// `maxBytes` (optional) bounds what is buffered: a Content-Length over the cap, or a stream that runs past it,
// throws an error with code 'too_large' instead of loading the whole file into memory.
async function getFileContent(itemPath, opts = {}) {
  const { maxBytes, ...rest } = opts;
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(itemPath)}:/content`, rest);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`graph-files: getFileContent failed for "${itemPath}" (${res.status})`);
  if (maxBytes === undefined) {
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  const tooLarge = () => Object.assign(new Error(`graph-files: "${itemPath}" exceeds ${maxBytes} bytes`), { code: 'too_large' });
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const { buffer, exceeded } = await readUpTo(res, maxBytes);
  if (exceeded) throw tooLarge();
  return buffer;
}

const QUARANTINE_FOLDER = 'Broker Submissions/_Quarantine';

// Moves one of THIS flow's own uploads (path must match UPLOAD_PATH_RE: Broker Submissions/<date>_<co>_<hex>/<file>)
// into Broker Submissions/_Quarantine, renamed "<submission folder>__<file>" to keep provenance. A move, never a
// delete: Gabriel can still open or purge it. Anything outside that shape is refused, so this cannot be pointed
// at another folder, and an item already in quarantine does not match the shape either.
async function quarantineUpload(itemPath, opts = {}) {
  if (typeof itemPath !== 'string' || !UPLOAD_PATH_RE.test(itemPath) || itemPath.split('/').includes('..')) {
    throw new Error('graph-files: quarantineUpload refused a path outside the broker upload shape');
  }
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const [, folder, file] = itemPath.split('/');
  await ensureFolder(QUARANTINE_FOLDER, opts);
  // Address the destination by item id: Graph's documented move shape, and immune to path-format quirks.
  const dest = await getItemByPath(QUARANTINE_FOLDER, opts);
  if (!dest || !dest.id) throw new Error('graph-files: quarantineUpload could not resolve the quarantine folder');
  const newName = sanitizeSegment(`${folder}__${file}`);
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(itemPath)}?@microsoft.graph.conflictBehavior=rename`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: newName,
      parentReference: { id: dest.id },
    }),
    ...opts,
  });
  if (!res.ok) throw new Error(`graph-files: quarantineUpload failed for "${itemPath}" (${res.status})`);
  return { path: `${QUARANTINE_FOLDER}/${newName}` };
}

module.exports = { ensureFolder, uploadSmallFile, createUploadSession, getItemByPath, getFileContent, getFileHead, quarantineUpload, QUARANTINE_FOLDER, sanitizeSegment };
