'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// OI-256: the public chat assistant (edge function) was pinned a model generation behind the
// broker extractor (function) because each file hardcoded its own id. Both now read ONE constant
// from netlify/functions/_shared/models.json, so a model bump is a one-line change that cannot
// leave one surface behind. Static check: no network, no deploy.

const ROOT = path.join(__dirname, '..', '..', '..');
const MODELS_JSON = path.join(ROOT, 'netlify', 'functions', '_shared', 'models.json');
const CHAT_EDGE = path.join(ROOT, 'netlify', 'edge-functions', 'chat.ts');
const BROKER_LLM = path.join(ROOT, 'netlify', 'functions', '_shared', 'broker-llm-extract.js');

const MODEL_ID = /claude-(?:sonnet|opus|haiku)-[0-9][a-z0-9-]*/;

function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('models.json exists and holds a single well-formed Anthropic model id', () => {
  assert.ok(fs.existsSync(MODELS_JSON), 'netlify/functions/_shared/models.json is missing');
  const cfg = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'));
  assert.deepEqual(Object.keys(cfg), ['model']);
  assert.match(cfg.model, /^claude-(?:sonnet|opus|haiku)-[0-9][a-z0-9-]*$/);
});

test('chat edge function takes its default model from models.json, with no hardcoded id', () => {
  const src = codeOnly(fs.readFileSync(CHAT_EDGE, 'utf8'));
  assert.match(src, /models\.json/);
  assert.doesNotMatch(src, MODEL_ID);
  assert.match(src, /Deno\.env\.get\('CHAT_MODEL'\)/, 'CHAT_MODEL env override must survive');
});

test('chat default is assigned from models.model exactly (a typo would give undefined)', () => {
  const src = codeOnly(fs.readFileSync(CHAT_EDGE, 'utf8'));
  assert.match(src, /const MODEL_DEFAULT\s*=\s*models\.model\s*;/);
});

test('broker default is assigned from models.json .model exactly', () => {
  const src = codeOnly(fs.readFileSync(BROKER_LLM, 'utf8'));
  assert.match(src, /const MODEL_DEFAULT\s*=\s*require\('\.\/models\.json'\)\.model\s*;/);
});

// claude-sonnet-5 rejects non-default sampling parameters with a 400, which /api/chat would turn
// into a 502 for every visitor. This is the exact trap the model bump walks into.
test('chat request sends no sampling parameters (Sonnet 5 returns 400 on temperature/top_p/top_k)', () => {
  const src = codeOnly(fs.readFileSync(CHAT_EDGE, 'utf8'));
  assert.doesNotMatch(src, /\btemperature\b|\btop_p\b|\btop_k\b|\bTEMPERATURE\b/);
});

// Sonnet 5 runs adaptive thinking when `thinking` is omitted (Sonnet 4.5 did not), and thinking
// tokens count against max_tokens (1024 here), which can truncate a visitor-facing answer.
test('chat request pins thinking off so max_tokens is spent on the answer', () => {
  const src = codeOnly(fs.readFileSync(CHAT_EDGE, 'utf8'));
  assert.match(src, /thinking:\s*\{\s*type:\s*'disabled'\s*\}/);
});

test('broker extractor takes its default model from models.json, with no hardcoded id', () => {
  const src = codeOnly(fs.readFileSync(BROKER_LLM, 'utf8'));
  assert.match(src, /models\.json/);
  assert.doesNotMatch(src, MODEL_ID);
  assert.match(src, /process\.env\.BROKER_SCORE_MODEL/, 'BROKER_SCORE_MODEL env override must survive');
});
