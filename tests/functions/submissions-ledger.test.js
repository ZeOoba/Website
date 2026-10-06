'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { handler } = require('../../netlify/functions/submissions-ledger.js');
const { buildEntry, rowForHeaders, toCell, formatReceivedET, schema } = require('../../netlify/functions/_shared/submissions-ledger.js');
const { _resetCacheForTests } = require('../../netlify/functions/_shared/graph-auth.js');

const ENV = {
  NETLIFY_WEBHOOK_SECRET: 'shh',
  GRAPH_TENANT_ID: 'tenant-1',
  GRAPH_CLIENT_ID: 'client-1',
  GRAPH_CLIENT_SECRET: 'secret-1',
  GRAPH_DRIVE_ID: 'drive-1',
  GRAPH_LEDGER_PATH: 'Website Submissions/ledger.xlsx',
};

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  _resetCacheForTests();
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

function signBody(rawBody, secret) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ iss: 'netlify', sha256: crypto.createHash('sha256').update(rawBody).digest('hex') });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function res(status, json) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json };
}

function headersFor(formName) {
  const def = schema.forms[formName];
  const fields = def ? def.fields.map(([, h]) => h) : ['Form'];
  return ['Received (ET)', 'Submission ID', 'Status', ...fields, 'Other Fields (JSON)', 'Notes'];
}

// Graph stub: token, header read, ID column read, then the write.
function graphStub({ headers, idColumn = [['']], failWrite = 0, calls = [] }) {
  let writeFailures = failWrite;
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.includes('login.microsoftonline.com')) return res(200, { access_token: 't', expires_in: 3600 });
    if (url.includes('/headerRowRange')) return res(200, { values: [headers] });
    if (url.includes('/dataBodyRange')) return res(200, { values: idColumn });
    if (url.includes('/rows/')) {
      if (writeFailures > 0) { writeFailures -= 1; return res(503, {}); }
      return res(200, {});
    }
    throw new Error(`unexpected url ${url}`);
  };
  impl.calls = calls;
  return impl;
}

function event(formName, data, id = 'abc12345def') {
  const rawBody = JSON.stringify({ form_name: formName, id, data });
  return { headers: { 'x-webhook-signature': signBody(rawBody, 'shh') }, body: rawBody };
}

// ---- pure logic ----

test('schema: every form has a unique table name and sheet name <= 31 chars', () => {
  const tables = new Set();
  const sheets = new Set();
  for (const d of [...Object.values(schema.forms), schema.fallback]) {
    assert.ok(d.sheet.length <= 31, d.sheet);
    assert.ok(!tables.has(d.table), `dup table ${d.table}`);
    assert.ok(!sheets.has(d.sheet), `dup sheet ${d.sheet}`);
    tables.add(d.table); sheets.add(d.sheet);
  }
});

test('schema: every Netlify form on the site that carries data has an entry', () => {
  for (const f of ['commercial-lease-application', 'contact', 'leasing-inquiry', 'owner-submission-intake', 'listing-inquiry',
    'checklist-download', 'chat-lead', 'broker-submission-intake', 'broker-network-ledger', 'pipeline-failures']) {
    assert.ok(schema.forms[f], f);
  }
});

test('toCell: forces formula-, number- and date-looking text to literal text', () => {
  assert.equal(toCell('=HYPERLINK("http://evil","x")'), `'=HYPERLINK("http://evil","x")`);
  assert.equal(toCell('+1 555 123 4567'), "'+1 555 123 4567");
  assert.equal(toCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(toCell('01234'), "'01234");
  assert.equal(toCell('2026-10-06'), "'2026-10-06");
  assert.equal(toCell('Jane Broker'), 'Jane Broker');
  assert.equal(toCell(''), '');
  assert.equal(toCell(null), '');
});

test('toCell: LEDGER_TEXT_PREFIX="" disables the prefix', () => withEnv({ ...ENV, LEDGER_TEXT_PREFIX: '' }, () => {
  assert.equal(toCell('=1+1'), '=1+1');
}));

test('formatReceivedET: renders Eastern wall-clock time', () => {
  assert.equal(formatReceivedET(new Date('2026-10-06T18:32:00Z')), '2026-10-06 14:32');
  assert.equal(formatReceivedET(new Date('2026-01-15T05:05:00Z')), '2026-01-15 00:05');
});

test('buildEntry: maps known fields by header, drops honeypot/recaptcha, keeps unknowns in JSON', () => {
  const { target, byHeader } = buildEntry({
    formName: 'contact',
    submissionId: 'sub-1',
    receivedAt: '2026-10-06 14:32',
    data: { name: 'Jane', email: 'j@x.com', message: 'hi', 'bot-field': '', 'form-name': 'contact', 'g-recaptcha-response': 'TOKEN', 'new-field': 'v' },
  });
  assert.deepEqual(target, { sheet: 'Contact', table: 'tblContact' });
  assert.equal(byHeader.Name, 'Jane');
  assert.equal(byHeader.Email, 'j@x.com');
  assert.equal(byHeader.Message, 'hi');
  assert.equal(byHeader.Status, 'New');
  assert.equal(byHeader['Submission ID'], 'sub-1');
  assert.deepEqual(JSON.parse(byHeader['Other Fields (JSON)']), { 'new-field': 'v' });
  assert.ok(!JSON.stringify(byHeader).includes('TOKEN'), 'recaptcha token must never reach the workbook');
});

test('buildEntry: tenant application records upload FILE NAMES and a docs-folder pointer, never file URLs', () => {
  const { byHeader } = buildEntry({
    formName: 'commercial-lease-application',
    submissionId: 'abcdef1234567890',
    receivedAt: 'x',
    data: {
      'full-legal-name': 'Pat Tenant',
      'upload-credit-report': { filename: 'credit.pdf', type: 'application/pdf', size: 10, url: 'https://secret.netlify/credit.pdf' },
      'upload-drivers-license': { filename: 'dl.jpg', url: 'https://secret.netlify/dl.jpg' },
    },
  });
  assert.equal(byHeader['Applicant Name'], 'Pat Tenant');
  assert.equal(byHeader['Uploaded Files'], 'credit-report: credit.pdf; drivers-license: dl.jpg');
  assert.equal(byHeader['Docs Folder (OneDrive)'], 'Tenant Applications/*_abcdef12');
  assert.ok(!JSON.stringify(byHeader).includes('secret.netlify'));
});

test('buildEntry: unknown form routes to Other Forms with full JSON', () => {
  const { target, byHeader } = buildEntry({ formName: 'future-form', submissionId: 's', receivedAt: 'r', data: { a: '1', 'bot-field': '' } });
  assert.deepEqual(target, { sheet: 'Other Forms', table: 'tblOtherForms' });
  assert.equal(byHeader.Form, 'future-form');
  assert.deepEqual(JSON.parse(byHeader['Other Fields (JSON)']), { a: '1' });
});

test('buildEntry: long text is capped (Excel cell limit) and control chars stripped', () => {
  const { byHeader } = buildEntry({ formName: 'contact', submissionId: 's', receivedAt: 'r', data: { message: `a\u0000${'b'.repeat(5000)}` } });
  assert.equal(byHeader.Message.length, 2000);
  assert.ok(!byHeader.Message.includes('\u0000'));
});

test('rowForHeaders: follows the LIVE header order, tolerates reordered and extra user columns', () => {
  const byHeader = { Name: 'Jane', Email: 'j@x.com', Status: 'New' };
  assert.deepEqual(rowForHeaders(['Email', 'My Custom Column', 'Name', 'Status'], byHeader), ['j@x.com', '', 'Jane', 'New']);
});

// ---- handler ----

test('rejects a forged signature with 401 and logs it', () => withEnv(ENV, async () => {
  let logged = false;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/' && String(opts.body || '').includes('pipeline-failures')) { logged = true; return { ok: true, status: 200 }; }
    throw new Error(`must not call network: ${url}`);
  };
  const out = await handler({ headers: { 'x-webhook-signature': 'a.b.c' }, body: '{}' }, { fetchImpl });
  assert.equal(out.statusCode, 401);
  assert.equal(logged, true);
}));

test('malformed JSON -> 400, no Graph call', () => withEnv(ENV, async () => {
  const raw = 'nope {';
  const out = await handler({ headers: { 'x-webhook-signature': signBody(raw, 'shh') }, body: raw }, { fetchImpl: async (u) => { throw new Error(`no network: ${u}`); } });
  assert.equal(out.statusCode, 400);
}));

test('appends a contact submission to the first free row, mapped by header', () => withEnv(ENV, async () => {
  const stub = graphStub({ headers: headersFor('contact'), idColumn: [['existing-1']] });
  const out = await handler(event('contact', { name: 'Jane', email: 'j@x.com', message: 'hello' }), { fetchImpl: stub });
  assert.equal(out.statusCode, 200);
  const write = stub.calls.find((c) => c.url.includes('/rows/add'));
  assert.ok(write, 'rows/add called');
  assert.equal(write.method, 'POST');
  assert.ok(write.url.includes('/tables/tblContact/'));
  const row = JSON.parse(write.body).values[0];
  const headers = headersFor('contact');
  assert.equal(row[headers.indexOf('Name')], 'Jane');
  assert.equal(row[headers.indexOf('Status')], 'New');
  assert.equal(row.length, headers.length);
}));

test('fills the template placeholder row in place on the first submission', () => withEnv(ENV, async () => {
  const stub = graphStub({ headers: headersFor('contact'), idColumn: [['']] });
  const out = await handler(event('contact', { name: 'Jane' }), { fetchImpl: stub });
  assert.equal(out.statusCode, 200);
  const write = stub.calls.find((c) => c.url.includes('rows/itemAt(index=0)'));
  assert.ok(write, 'placeholder PATCH used');
  assert.equal(write.method, 'PATCH');
  assert.ok(!stub.calls.some((c) => c.url.includes('/rows/add')));
}));

test('a redelivered submission is not appended twice', () => withEnv(ENV, async () => {
  const stub = graphStub({ headers: headersFor('contact'), idColumn: [['abc12345def']] });
  const out = await handler(event('contact', { name: 'Jane' }, 'abc12345def'), { fetchImpl: stub });
  assert.equal(out.statusCode, 200);
  assert.equal(JSON.parse(out.body).duplicate, true);
  assert.ok(!stub.calls.some((c) => c.url.includes('/rows/')));
}));

test('retries a transient Graph 503 and then succeeds', () => withEnv(ENV, async () => {
  const stub = graphStub({ headers: headersFor('contact'), idColumn: [['x']], failWrite: 2 });
  const out = await handler(event('contact', { name: 'Jane' }), { fetchImpl: stub });
  assert.equal(out.statusCode, 200);
  assert.equal(stub.calls.filter((c) => c.url.includes('/rows/add')).length, 3);
}));

test('persistent Graph failure -> 502 AND logged to pipeline-failures', () => withEnv(ENV, async () => {
  let failureLogged = false;
  const stub = graphStub({ headers: headersFor('contact'), idColumn: [['x']], failWrite: 99 });
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/') { failureLogged = String(opts.body).includes('ledger_append_failed'); return { ok: true, status: 200 }; }
    return stub(url, opts);
  };
  const out = await handler(event('contact', { name: 'Jane' }), { fetchImpl });
  assert.equal(out.statusCode, 502);
  assert.equal(failureLogged, true);
}));

test('LOOP GUARD: a failed ledger write for a pipeline-failures row is NOT re-logged to pipeline-failures', () => withEnv(ENV, async () => {
  let relogged = false;
  const stub = graphStub({ headers: headersFor('pipeline-failures'), idColumn: [['x']], failWrite: 99 });
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://oxfordra.net/') { relogged = true; return { ok: true, status: 200 }; }
    return stub(url, opts);
  };
  const out = await handler(event('pipeline-failures', { 'source-function': 'x', 'error-code': 'y' }), { fetchImpl });
  assert.equal(out.statusCode, 502);
  assert.equal(relogged, false, 'logging would re-trigger this webhook and loop during an outage');
}));
