'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// lighthouse-summary.mjs is ESM; the unit runner is CommonJS, so load it dynamically.
const load = () => import('../../scripts/lighthouse-summary.mjs');

const lhr = (over = {}) => ({
  finalDisplayedUrl: 'http://127.0.0.1:8788/',
  categories: { performance: { score: 0.97 }, accessibility: { score: 1 }, 'best-practices': { score: 1 }, seo: { score: 1 }, ...(over.categories || {}) },
  audits: {
    'largest-contentful-paint': { numericValue: 1800 },
    'cumulative-layout-shift': { numericValue: 0 },
    'total-blocking-time': { numericValue: 120 },
    ...(over.audits || {}),
  },
});

test('a report inside every budget produces no findings', async () => {
  const { evaluate } = await load();
  const r = evaluate(lhr());
  assert.deepEqual(r.over, []);
  assert.equal(r.scores.performance, 97);
});

test('each metric and category over budget is named, with the numbers', async () => {
  const { evaluate } = await load();
  const r = evaluate(lhr({
    categories: { performance: { score: 0.82 }, seo: { score: 0.85 } },
    audits: { 'largest-contentful-paint': { numericValue: 3400 }, 'cumulative-layout-shift': { numericValue: 0.27 }, 'total-blocking-time': { numericValue: 410 } },
  }));
  assert.deepEqual(r.over, ['LCP 3.40 s > 2.5 s', 'CLS 0.270 > 0.1', 'TBT 410 ms > 200 ms', 'performance 82 < 90', 'seo 85 < 90']);
});

test('the markdown table carries one row per page with its status', async () => {
  const { evaluate, markdown } = await load();
  const md = markdown([evaluate(lhr()), evaluate(lhr({ audits: { 'total-blocking-time': { numericValue: 999 } } }))]);
  assert.match(md, /\| \/ \| 97 \| 100 \| 100 \| 100 \| 1\.80 s \| 0\.000 \| 120 ms \| within budget \|/);
  assert.match(md, /TBT 999 ms > 200 ms/);
  assert.match(md, /never fails the build/);
});
