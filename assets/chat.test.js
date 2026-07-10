'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('./chat.js');

test('bare oxfordra.net URL at end of sentence does not swallow the trailing period', () => {
  const html = renderMarkdown('See our portfolio at oxfordra.net/portfolio. Thanks for asking.');
  assert.match(html, /href="https:\/\/oxfordra\.net\/portfolio"/);
  assert.doesNotMatch(html, /href="https:\/\/oxfordra\.net\/portfolio\."/);
});

test('bare https URL followed by a comma does not swallow the comma', () => {
  const html = renderMarkdown('More info at https://example.com/page, see below.');
  assert.match(html, /href="https:\/\/example\.com\/page"/);
  assert.doesNotMatch(html, /href="https:\/\/example\.com\/page,"/);
});

test('bare URL at end of sentence with closing parenthesis does not swallow it', () => {
  const html = renderMarkdown('See oxfordra.net/about (our firm page).');
  assert.match(html, /href="https:\/\/oxfordra\.net\/about"/);
});

test('markdown-style [label](url) links are unaffected by trailing-punctuation trimming', () => {
  const html = renderMarkdown('[Available Space](https://oxfordra.net/available-space)');
  assert.match(html, /href="https:\/\/oxfordra\.net\/available-space"/);
  assert.match(html, />Available Space</);
});

test('a bare URL that is the entire message (no trailing punctuation) is untouched', () => {
  const html = renderMarkdown('oxfordra.net/contact');
  assert.match(html, /href="https:\/\/oxfordra\.net\/contact"/);
});
