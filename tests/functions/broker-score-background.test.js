'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScoring } = require('../../netlify/functions/_shared/broker-scoring-run.js');

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
