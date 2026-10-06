'use strict';
/**
 * _shared/submissions-ledger.js
 *
 * Appends one row per Netlify form submission to an Excel workbook on
 * SharePoint/OneDrive (one Excel Table per form type) through Microsoft Graph.
 * Schema lives in submissions-schema.json (shared with the template builder).
 *
 * Design rules:
 *  - Values are mapped to columns BY HEADER NAME, read live from the table, so
 *    reordering or adding columns in Excel never mis-files data.
 *  - A field the schema does not know is never dropped: it lands in
 *    "Other Fields (JSON)". A form the schema does not know goes to "Other Forms".
 *  - Anything that Excel could interpret as a formula, number or date is
 *    forced to text (see toCell) — submissions are untrusted input.
 *  - Appending is idempotent per Submission ID (Netlify redelivers webhooks).
 */
const path = require('node:path');
const fs = require('node:fs');
const schema = require('./submissions-schema.json');
const { sanitizeField } = require('./validate.js');
const { graphFetch, encodeGraphPath, ensureFolder } = require('./graph-files.js');

const DEFAULT_WORKBOOK_PATH = 'Website Submissions/ORA_Website_Submissions_v1.0.xlsx';
const TEMPLATE_PATH = path.join(__dirname, 'submissions-template.xlsx');
const FIXED_LEAD = ['Received (ET)', 'Submission ID', 'Status'];
const OTHER_JSON = 'Other Fields (JSON)';
const RETRYABLE = new Set([409, 423, 429, 500, 502, 503, 504]);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`submissions-ledger: missing ${name}`);
  return v;
}

function workbookPath() {
  return process.env.GRAPH_LEDGER_PATH || DEFAULT_WORKBOOK_PATH;
}

// Excel (via Graph) treats a string starting with = as a formula and coerces
// digit-led strings to numbers/dates (losing leading zeros on ZIPs, mangling
// phone numbers). A leading apostrophe stores the cell as literal text.
// LEDGER_TEXT_PREFIX="" disables it (verify behavior on a test row first).
function toCell(value) {
  const prefix = process.env.LEDGER_TEXT_PREFIX === undefined ? "'" : process.env.LEDGER_TEXT_PREFIX;
  const s = value == null ? '' : String(value);
  if (!s) return '';
  return prefix && /^[=+\-@\t\r\d]/.test(s) ? `${prefix}${s}` : s;
}

function formatReceivedET(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function describeValue(value) {
  // Netlify serializes a file-upload field as {filename, type, size, url}.
  if (value && typeof value === 'object') {
    if (typeof value.filename === 'string') return value.filename;
    return JSON.stringify(value);
  }
  return value;
}

function maxLenFor(key) {
  return schema.longTextKeys[key] || schema.defaultMaxLen;
}

/**
 * Pure: turns a webhook submission into { target, valuesByHeader }.
 * No network, no env — unit-testable.
 */
function buildEntry({ formName, data, submissionId, receivedAt }) {
  const def = schema.forms[formName];
  const target = def ? { sheet: def.sheet, table: def.table } : { sheet: schema.fallback.sheet, table: schema.fallback.table };
  const skip = new Set(schema.skipKeys);
  const uploads = new Set((def && def.uploads) || []);
  const known = new Map(def ? def.fields.map(([k, header]) => [k, header]) : []);
  const byHeader = {
    'Received (ET)': receivedAt,
    'Submission ID': String(submissionId || ''),
    Status: 'New',
  };
  const other = {};
  const uploadNames = [];

  for (const [key, raw] of Object.entries(data || {})) {
    if (skip.has(key)) continue;
    if (uploads.has(key)) {
      const name = describeValue(raw);
      if (name) uploadNames.push(`${key.replace('upload-', '')}: ${sanitizeField(String(name), 200)}`);
      continue;
    }
    const value = sanitizeField(String(describeValue(raw) == null ? '' : describeValue(raw)), maxLenFor(key));
    if (known.has(key)) byHeader[known.get(key)] = value;
    else if (value !== '') other[key] = value;
  }

  if (def && known.has('__uploads')) byHeader[known.get('__uploads')] = uploadNames.join('; ');
  if (def && known.has('__docs_folder') && submissionId) {
    // Matches tenant-application-processor's folder: "<date>_<slug>_<first 8 of id>".
    byHeader[known.get('__docs_folder')] = `Tenant Applications/*_${String(submissionId).slice(0, 8)}`;
  }

  if (!def) {
    byHeader['Form'] = formName || '(unknown)';
    byHeader[OTHER_JSON] = JSON.stringify(
      Object.fromEntries(Object.entries(data || {}).filter(([k]) => !skip.has(k)).map(([k, v]) => [k, sanitizeField(String(describeValue(v) == null ? '' : describeValue(v)), maxLenFor(k))]))
    );
  } else if (Object.keys(other).length) {
    byHeader[OTHER_JSON] = JSON.stringify(other);
  }
  return { target, byHeader };
}

function rowForHeaders(headers, byHeader) {
  return headers.map((h) => toCell(byHeader[h] === undefined ? '' : byHeader[h]));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Graph's workbook API serializes per-workbook and answers 409/423/429/5xx
// under contention; a short bounded retry absorbs bursts without blowing the
// function's time limit.
async function wb(pathSuffix, { method = 'GET', body, fetchImpl, attempts = 4 } = {}) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const url = `/drives/${driveId}/root:/${encodeGraphPath(workbookPath())}:/workbook${pathSuffix}`;
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = await graphFetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      fetchImpl,
    });
    if (last.ok || !RETRYABLE.has(last.status)) return last;
    const retryAfter = Number(last.headers && last.headers.get && last.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** i + Math.floor(Math.random() * 150), 2000));
  }
  return last;
}

async function bootstrapWorkbook(fetchImpl) {
  const driveId = requireEnv('GRAPH_DRIVE_ID');
  const p = workbookPath();
  const folder = p.split('/').slice(0, -1).join('/');
  const name = p.split('/').pop();
  if (folder) await ensureFolder(folder, { fetchImpl });
  const template = fs.readFileSync(TEMPLATE_PATH);
  // conflictBehavior=fail: a concurrent first submission must never overwrite
  // a workbook (and the rows) the other invocation just created.
  const res = await graphFetch(`/drives/${driveId}/root:/${encodeGraphPath(`${folder ? `${folder}/` : ''}${name}`)}:/content?@microsoft.graph.conflictBehavior=fail`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: template,
    fetchImpl,
  });
  if (!res.ok && res.status !== 409) throw new Error(`submissions-ledger: workbook bootstrap failed (${res.status})`);
}

async function readHeaders(table, fetchImpl) {
  let res = await wb(`/tables/${encodeURIComponent(table)}/headerRowRange?$select=values`, { fetchImpl });
  if (res.status === 404) {
    // Either the workbook file or the table is missing. Create the workbook
    // from the template if the file is absent, then re-read once.
    await bootstrapWorkbook(fetchImpl);
    res = await wb(`/tables/${encodeURIComponent(table)}/headerRowRange?$select=values`, { fetchImpl });
  }
  if (!res.ok) throw new Error(`submissions-ledger: header read failed for ${table} (${res.status})`);
  const json = await res.json();
  return (json.values && json.values[0]) || [];
}

// Reads the Submission ID column once and answers two questions: is this
// submission already logged (webhook redelivery), and is the table still just
// the template's single blank placeholder row (Excel tables need one body
// row, so the template ships one; the first submission fills it in place
// rather than leaving a gap above it).
async function inspectTable(table, submissionId, fetchImpl) {
  try {
    const res = await wb(`/tables/${encodeURIComponent(table)}/columns/${encodeURIComponent('Submission ID')}/dataBodyRange?$select=values`, { fetchImpl, attempts: 2 });
    if (!res.ok) return { duplicate: false, placeholder: false }; // never block a write on this check
    const json = await res.json();
    const col = (json.values || []).map((row) => String(row[0] == null ? '' : row[0]));
    return {
      duplicate: Boolean(submissionId) && col.some((v) => v === String(submissionId)),
      placeholder: col.length === 1 && col[0] === '',
    };
  } catch {
    return { duplicate: false, placeholder: false };
  }
}

/**
 * Appends one submission. Returns { appended: boolean, duplicate?: true, table }.
 * Throws on failure — the caller decides how to surface it.
 */
async function appendSubmission({ formName, data, submissionId, fetchImpl = fetch, now = new Date() }) {
  const { target, byHeader } = buildEntry({ formName, data, submissionId, receivedAt: formatReceivedET(now) });
  const headers = await readHeaders(target.table, fetchImpl);
  if (!headers.length) throw new Error(`submissions-ledger: table ${target.table} has no header row`);
  const { duplicate, placeholder } = await inspectTable(target.table, submissionId, fetchImpl);
  if (duplicate) return { appended: false, duplicate: true, table: target.table };
  const values = [rowForHeaders(headers, byHeader)];
  const res = placeholder
    ? await wb(`/tables/${encodeURIComponent(target.table)}/rows/itemAt(index=0)`, { method: 'PATCH', body: { values }, fetchImpl })
    : await wb(`/tables/${encodeURIComponent(target.table)}/rows/add`, { method: 'POST', body: { values }, fetchImpl });
  if (!res.ok) throw new Error(`submissions-ledger: row ${placeholder ? 'fill' : 'append'} failed for ${target.table} (${res.status})`);
  return { appended: true, table: target.table, filledPlaceholder: placeholder };
}

module.exports = {
  appendSubmission, buildEntry, rowForHeaders, toCell, formatReceivedET,
  schema, FIXED_LEAD, OTHER_JSON, DEFAULT_WORKBOOK_PATH,
};
