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

test('broker extractor takes its default model from models.json, with no hardcoded id', () => {
  const src = codeOnly(fs.readFileSync(BROKER_LLM, 'utf8'));
  assert.match(src, /models\.json/);
  assert.doesNotMatch(src, MODEL_ID);
  assert.match(src, /process\.env\.BROKER_SCORE_MODEL/, 'BROKER_SCORE_MODEL env override must survive');
});
