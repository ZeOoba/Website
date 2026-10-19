'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { signIntakeToken } = require('../../netlify/functions/_shared/validate.js');

// broker-scoring-run is ESM (it imports broker-score-store.mjs, which must be
// ESM so esbuild bundles @netlify/blobs). Load it lazily and delegate, so the
// assertions below stay unchanged.
let runModulePromise;
function runScoring(...args) {
  runModulePromise ||= import(
    pathToFileURL(path.join(__dirname, '..', '..', 'netlify', 'functions', '_shared', 'broker-scoring-run.mjs')).href
  );
  return runModulePromise.then((m) => m.runScoring(...args));
}

const READY_EXTRACTION = {
  askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'industrial', buildingGrade: 'B',
  clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
  valueAddSignals: ['vacancy'], notes: null,
};

function makeDeps(overrides = {}) {
  return {
    fetchImpl: async () => { throw new Error('unexpected direct fetch — inject a fake for the specific dependency instead'); },
    getItemByPathImpl: async () => ({ id: 'item-1', size: 1000, webUrl: 'https://x/om.pdf' }),
    getFileContentImpl: async () => Buffer.from('%PDF-1.4 fake'),
    extractForScoringImpl: async () => ({ ok: true, kind: 'pdf', base64: 'ZmFrZQ==' }),
    extractDealTermsImpl: async () => READY_EXTRACTION,
    hasBeenScoredImpl: async () => false,
    markScoredImpl: async () => {},
    writeScoreResultImpl: async () => {},
    forwardToNetlifyFormImpl: async () => {},
    sendMailImpl: async () => {},
    ...overrides,
  };
}

test('runScoring writes a ready result and sends the follow-up email on a clean deal', async () => {
  const writes = [];
  const emails = [];
  const deps = makeDeps({
    writeScoreResultImpl: async (id, result) => writes.push({ id, result }),
    sendMailImpl: async (args) => emails.push(args),
  });
  const result = await runScoring({ submissionId: 'sub-1', itemPath: 'Broker Submissions/x/om.pdf', fields: { company: 'Acme' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].result.status, 'ready');
  assert.ok(writes[0].result.finalScore >= 90);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /Acme/);
});

test('runScoring skips entirely if the item path was already scored (idempotency)', async () => {
  const writes = [];
  const deps = makeDeps({
    hasBeenScoredImpl: async () => true,
    writeScoreResultImpl: async (id, result) => writes.push({ id, result }),
  });
  const result = await runScoring({ submissionId: 'sub-2', itemPath: 'Broker Submissions/x/om.pdf', fields: {} }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'already_scored');
  assert.equal(writes.length, 0);
});

test('runScoring writes an unavailable result when extraction fails, and never throws', async () => {
  const writes = [];
  const failures = [];
  const deps = makeDeps({
    extractForScoringImpl: async () => ({ ok: false, reason: 'unparseable_file' }),
    writeScoreResultImpl: async (id, result) => writes.push({ id, result }),
    forwardToNetlifyFormImpl: async (siteUrl, formName, fields) => failures.push({ formName, fields }),
  });
  const result = await runScoring({ submissionId: 'sub-3', itemPath: 'Broker Submissions/x/om.pdf', fields: {} }, deps);
  assert.equal(result.ok, false);
  assert.equal(writes[0].result.status, 'unavailable');
  assert.equal(failures[0].formName, 'pipeline-failures');
  assert.equal(failures[0].fields['error-code'], 'unparseable_file');
});

test('runScoring writes an unavailable result when the LLM call throws, and logs the failure', async () => {
  const writes = [];
  const deps = makeDeps({
    extractDealTermsImpl: async () => { throw new Error('anthropic 500'); },
    writeScoreResultImpl: async (id, result) => writes.push({ id, result }),
  });
  const result = await runScoring({ submissionId: 'sub-4', itemPath: 'Broker Submissions/x/om.pdf', fields: {} }, deps);
  assert.equal(result.ok, false);
  assert.equal(writes[0].result.status, 'unavailable');
});

test('runScoring writes an unavailable result and never throws when scoreDealImpl throws after extraction succeeds', async () => {
  const writes = [];
  const failures = [];
  const deps = makeDeps({
    // scoreDealImpl is called synchronously (not awaited) in runScoring, so
    // the test double must throw synchronously to simulate a malformed-shape
    // TypeError from the real (sync) scoreDeal implementation.
    scoreDealImpl: () => { throw new Error('malformed extraction'); },
    writeScoreResultImpl: async (id, result) => writes.push({ id, result }),
    forwardToNetlifyFormImpl: async (siteUrl, formName, fields) => failures.push({ formName, fields }),
  });
  const result = await runScoring({ submissionId: 'sub-6', itemPath: 'Broker Submissions/x/om.pdf', fields: {} }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_error');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].result.status, 'unavailable');
  assert.equal(writes[0].result.reason, 'unexpected_error');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].formName, 'pipeline-failures');
  assert.equal(failures[0].fields['error-code'], 'unexpected_error');
});

test('runScoring still reports success if the follow-up email fails (scoring already succeeded)', async () => {
  const writes = [];
  const failures = [];
  const deps = makeDeps({
    writeScoreResultImpl: async (id, result) => writes.push({ id, result }),
    sendMailImpl: async () => { throw new Error('graph mail down'); },
    forwardToNetlifyFormImpl: async (siteUrl, formName, fields) => failures.push({ formName, fields }),
  });
  const result = await runScoring({ submissionId: 'sub-5', itemPath: 'Broker Submissions/x/om.pdf', fields: { company: 'Acme' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(writes[0].result.status, 'ready');
  assert.equal(failures[0].fields['error-code'], 'followup_email_failed');
});

test('runScoring never throws when scoreDealImpl throws AND the outer catch\'s logFailure call also throws', async () => {
  const writes = [];
  const deps = makeDeps({
    // Reach the outer catch via a synchronous throw from scoreDealImpl...
    scoreDealImpl: () => { throw new Error('malformed extraction'); },
    writeScoreResultImpl: async (id, result) => writes.push({ id, result }),
    // ...then make the outer catch's own logFailure -> forwardToNetlifyFormImpl
    // call throw too (e.g. the real network-backed dependency fails). Before
    // the fix, this second throw had nothing left to catch it and escaped
    // runScoring uncaught.
    forwardToNetlifyFormImpl: async () => { throw new Error('netlify forms down'); },
  });
  const result = await runScoring({ submissionId: 'sub-7', itemPath: 'Broker Submissions/x/om.pdf', fields: {} }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_error');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].result.status, 'unavailable');
  assert.equal(writes[0].result.reason, 'unexpected_error');
});

// --- default handler (the public entry point) --------------------------
// The tests above exercise runScoring's internals directly. These cover the
// handler's own boundary: broker-score-background is a PUBLIC Netlify
// Function URL with no caller identity of its own, so it must reject a
// caller-supplied itemPath/submissionId that doesn't carry a valid
// authToken minted by broker-finalize.mjs (fix for the unauthenticated
// SharePoint-read-and-persist exposure — cc-audit-army finding
// unauth-sharepoint-read-oracle-via-background-fn).
let handlerModulePromise;
function loadHandler() {
  handlerModulePromise ||= import(
    pathToFileURL(path.join(__dirname, '..', '..', 'netlify', 'functions', 'broker-score-background.mjs')).href
  );
  return handlerModulePromise;
}

const SECRET = 'bg-test-secret';
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) process.env[k] = prev[k]; });
}

async function callHandler(body, deps) {
  const { handleScoreBackground } = await loadHandler();
  const req = new Request('https://oxfordra.net/.netlify/functions/broker-score-background', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleScoreBackground(req, deps);
}

const VALID_PATH = 'Broker Submissions/2026-08-18_Acme-Co_ab12cd34/om.pdf';
const VALID_SUB = 'a'.repeat(24);

test('handler rejects a caller-supplied itemPath/submissionId with no authToken (the unauth exposure)', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const res = await callHandler({ submissionId: VALID_SUB, itemPath: VALID_PATH });
  assert.equal(res.status, 401);
}));

test('handler rejects an authToken signed with the wrong secret (forged token)', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const authToken = signIntakeToken({ type: 'bg-auth', submissionId: VALID_SUB, itemPath: VALID_PATH, exp: Date.now() + 60_000 }, 'wrong-secret');
  const res = await callHandler({ submissionId: VALID_SUB, itemPath: VALID_PATH, authToken });
  assert.equal(res.status, 401);
}));

test('handler rejects a valid authToken bound to a DIFFERENT itemPath (cannot redirect a legit token at another file)', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const authToken = signIntakeToken({ type: 'bg-auth', submissionId: VALID_SUB, itemPath: 'Broker Submissions/2026-08-18_Acme-Co_ab12cd34/other.pdf', exp: Date.now() + 60_000 }, SECRET);
  const res = await callHandler({ submissionId: VALID_SUB, itemPath: VALID_PATH, authToken });
  assert.equal(res.status, 401);
}));

test('handler rejects an itemPath outside the Broker Submissions/<date>_<slug>_<hex>/ shape even with a token for it', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const evilPath = '../../secrets/confidential-terms.json';
  const authToken = signIntakeToken({ type: 'bg-auth', submissionId: VALID_SUB, itemPath: evilPath, exp: Date.now() + 60_000 }, SECRET);
  const res = await callHandler({ submissionId: VALID_SUB, itemPath: evilPath, authToken });
  assert.equal(res.status, 400);
}));

test('handler rejects a submissionId that is not the expected 24-hex-char shape', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const badSub = 'not-a-valid-submission-id';
  const authToken = signIntakeToken({ type: 'bg-auth', submissionId: badSub, itemPath: VALID_PATH, exp: Date.now() + 60_000 }, SECRET);
  const res = await callHandler({ submissionId: badSub, itemPath: VALID_PATH, authToken });
  assert.equal(res.status, 400);
}));

test('handler accepts a correctly-bound authToken, calls runScoring, and returns 202', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const authToken = signIntakeToken({ type: 'bg-auth', submissionId: VALID_SUB, itemPath: VALID_PATH, exp: Date.now() + 60_000 }, SECRET);
  const calls = [];
  const res = await callHandler(
    { submissionId: VALID_SUB, itemPath: VALID_PATH, fields: { company: 'Acme' }, authToken },
    { runScoringImpl: async (args) => { calls.push(args); return { ok: true }; } }
  );
  assert.equal(res.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].submissionId, VALID_SUB);
  assert.equal(calls[0].itemPath, VALID_PATH);
  assert.equal(calls[0].fields.company, 'Acme');
}));

// Cross-boundary-type + auth-order regression pins (2026-08-21 adversarial-review fixes).
test('handler rejects a correctly-signed token of the WRONG type (e.g. an "upload" token replayed here)', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const wrongTypeToken = signIntakeToken({ type: 'upload', submissionId: VALID_SUB, itemPath: VALID_PATH, exp: Date.now() + 60_000 }, SECRET);
  const res = await callHandler({ submissionId: VALID_SUB, itemPath: VALID_PATH, authToken: wrongTypeToken });
  assert.equal(res.status, 401);
}));

test('handler returns 401, not 400, for an invalid-shape submissionId with no authToken (auth is checked before shape, so an unauthenticated caller gets no shape-match signal)', () => withEnv({ INTAKE_TOKEN_SECRET: SECRET }, async () => {
  const res = await callHandler({ submissionId: 'not-a-valid-submission-id', itemPath: VALID_PATH });
  assert.equal(res.status, 401);
}));

// 2026-09-30 audit (oxfordra.net item 5): Netlify Forms silently drops any field a registered form
// does not declare, so every key a function posts to broker-network-ledger must be declared.
test('every field runScoring posts to broker-network-ledger is declared in broker-ledger-form.html', async () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'broker-ledger-form.html'), 'utf8');
  const declared = new Set([...html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]));
  const posted = [];
  const deps = makeDeps({ forwardToNetlifyFormImpl: async (siteUrl, formName, fields) => { if (formName === 'broker-network-ledger') posted.push(fields); } });
  await runScoring({ submissionId: 'sub-ledger', itemPath: 'Broker Submissions/x/om.pdf', fields: { company: 'Acme' } }, deps);
  assert.equal(posted.length, 1);
  const undeclared = Object.keys(posted[0]).filter((k) => !declared.has(k));
  assert.deepEqual(undeclared, [], `undeclared ledger fields would be dropped by Netlify Forms: ${undeclared.join(', ')}`);
  assert.equal(posted[0]['submission-id'], 'sub-ledger');
  assert.equal(posted[0]['score-coverage'], 100);
});

test('runScoring still logs the ledger row, with an empty score, when the score is withheld', async () => {
  const posted = [];
  const writes = [];
  const deps = makeDeps({
    extractDealTermsImpl: async () => ({ askingPrice: null, buildingSizeSF: 30_000, assetClass: null, buildingGrade: null, clearHeightFt: 20, city: null, state: null, matchedRctMarket: null, yearBuilt: null, valueAddSignals: [], notes: null }),
    writeScoreResultImpl: async (id, r) => writes.push(r),
    forwardToNetlifyFormImpl: async (siteUrl, formName, fields) => { if (formName === 'broker-network-ledger') posted.push(fields); },
  });
  await runScoring({ submissionId: 'sub-thin', itemPath: 'Broker Submissions/x/om.pdf', fields: { company: 'Thin' } }, deps);
  assert.equal(writes[0].insufficientData, true);
  assert.equal(posted[0]['score-total'], '');
  assert.equal(posted[0]['score-coverage'], 35);
});

// A needs-review row must be distinguishable from a low-coverage withhold at the ledger's top level: both
// have an empty score-total. The flag is an additive field on the existing form (declared in
// broker-ledger-form.html; the declared-fields test above guards that).
test('the ledger row carries score-needs-review: true for a needs-review result, false for a low-coverage withhold and a scored deal', async () => {
  const run = async (extracted) => {
    const posted = [];
    const deps = makeDeps({
      extractDealTermsImpl: async () => extracted,
      forwardToNetlifyFormImpl: async (siteUrl, formName, fields) => { if (formName === 'broker-network-ledger') posted.push(fields); },
    });
    await runScoring({ submissionId: 'sub-flag', itemPath: 'Broker Submissions/x/om.pdf', fields: { company: 'Flag' } }, deps);
    return posted[0];
  };
  const base = { askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'industrial', buildingGrade: 'B', clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990, valueAddSignals: ['vacancy'], notes: null };
  const review = await run({ ...base, yearBuilt: 3000 });
  assert.equal(review['score-total'], '');
  assert.equal(review['score-needs-review'], 'true');
  const thin = await run({ ...base, askingPrice: null, assetClass: null, city: null, state: null, matchedRctMarket: null, clearHeightFt: null, valueAddSignals: [] });
  assert.equal(thin['score-total'], '');
  assert.equal(thin['score-needs-review'], 'false');
  const scored = await run(base);
  assert.equal(typeof scored['score-total'], 'number');
  assert.equal(scored['score-needs-review'], 'false');
});
