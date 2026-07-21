'use strict';
const { getGraphToken } = require('./graph-auth.js');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`graph-files: missing ${name}`);
  return v;
}

function sanitizeSegment(segment) {
  return String(segment).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120).trim() || 'untitled';
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

async function getFileContent(itemPath, opts = {}) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(itemPath)}:/content`, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`graph-files: getFileContent failed for "${itemPath}" (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { ensureFolder, uploadSmallFile, createUploadSession, getItemByPath, getFileContent };
