'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// application-script.js is a DOM IIFE with no exports. Rather than add a
// jsdom dependency for three assertions, this test asserts the *budget
// table* the fix must use — extracted as a small pure function the fix
// will add to application-script.js. See Step 3 for why this function
// exists as a standalone, testable unit inside the same file.
const { FILE_FIELD_BUDGETS, AGGREGATE_BUDGET_BYTES, sumSelectedBytes } = require('./application-script.js');

test('per-field budgets sum to at most the aggregate budget', () => {
  const sum = Object.values(FILE_FIELD_BUDGETS).reduce((a, b) => a + b, 0);
  assert.ok(sum <= AGGREGATE_BUDGET_BYTES, `budgets sum to ${sum}, exceeds aggregate ${AGGREGATE_BUDGET_BYTES}`);
});

test('aggregate budget stays under Netlify Forms 8 MB whole-submission cap', () => {
  const NETLIFY_FORMS_CAP_BYTES = 8 * 1024 * 1024;
  assert.ok(AGGREGATE_BUDGET_BYTES < NETLIFY_FORMS_CAP_BYTES, 'aggregate budget must leave headroom under the 8 MB cap');
});

test('sumSelectedBytes adds sizes across multiple file inputs', () => {
  const fakeInputs = [{ files: [{ size: 1_000_000 }] }, { files: [{ size: 2_000_000 }] }, { files: [] }];
  assert.equal(sumSelectedBytes(fakeInputs), 3_000_000);
});
