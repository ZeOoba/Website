'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDealTerms } = require('../../../netlify/functions/_shared/broker-llm-extract.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(vars)) process.env[k] = prev[k]; });
}

const FAKE_EXTRACTION = {
  askingPrice: 2_000_000, buildingSizeSF: 40_000, assetClass: 'industrial', buildingGrade: 'B',
  clearHeightFt: 20, city: 'Columbus', state: 'OH', matchedRctMarket: 'Columbus', yearBuilt: 1990,
  valueAddSignals: ['vacancy'], notes: 'Test extraction.',
};

test('extractDealTerms sends the PDF as a native document block and forces the extraction tool', () => withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'record_deal_terms', input: FAKE_EXTRACTION }] }),
    };
  };
  const result = await extractDealTerms({ ok: true, kind: 'pdf', base64: 'ZmFrZQ==' }, { fetchImpl });
  assert.deepEqual(result, FAKE_EXTRACTION);
  assert.equal(capturedBody.tool_choice.type, 'tool');
  assert.equal(capturedBody.tool_choice.name, 'record_deal_terms');
  assert.equal(capturedBody.thinking, undefined); // forced tool_choice is incompatible with extended thinking
  const docBlock = capturedBody.messages[0].content.find((b) => b.type === 'document');
  assert.equal(docBlock.source.type, 'base64');
  assert.equal(docBlock.source.media_type, 'application/pdf');
  assert.equal(docBlock.source.data, 'ZmFrZQ==');
}));

test('extractDealTerms sends extracted text as a plain text block for non-PDF content', () => withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'record_deal_terms', input: FAKE_EXTRACTION }] }) };
  };
  await extractDealTerms({ ok: true, kind: 'text', text: 'Rent Roll: Acme Co, 5000 SF' }, { fetchImpl });
  const textBlock = capturedBody.messages[0].content.find((b) => b.type === 'text');
  assert.match(textBlock.text, /Acme Co/);
}));

test('extractDealTerms throws on a non-OK API response', () => withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server error' });
  await assert.rejects(() => extractDealTerms({ ok: true, kind: 'pdf', base64: 'x' }, { fetchImpl }));
}));

test('extractDealTerms throws when the response has no tool_use block', () => withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'I could not extract this.' }] }) });
  await assert.rejects(() => extractDealTerms({ ok: true, kind: 'pdf', base64: 'x' }, { fetchImpl }));
}));

test('extractDealTerms throws when ANTHROPIC_API_KEY is missing', () => withEnv({ ANTHROPIC_API_KEY: '' }, async () => {
  await assert.rejects(() => extractDealTerms({ ok: true, kind: 'pdf', base64: 'x' }, { fetchImpl: async () => { throw new Error('must not call network'); } }));
}));
