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

test('markdown-style [label](url) for an oxfordra.net URL is not double-processed into a nested anchor', () => {
  // The bare-oxfordra.net-URL autolinker used to have no guard against
  // matching text already inside an href="..." produced by the
  // [label](url) regex that runs just before it, corrupting the markup
  // into a malformed nested <a>. Assert exactly one anchor is produced.
  const html = renderMarkdown('[Portfolio](https://oxfordra.net/portfolio)');
  const anchorOpens = (html.match(/<a /g) || []).length;
  assert.equal(anchorOpens, 1, 'expected exactly one <a> tag, got: ' + html);
  assert.equal(html, '<p><a href="https://oxfordra.net/portfolio" target="_blank" rel="noopener noreferrer">Portfolio</a></p>');
});

test('bare https URL for oxfordra.net is not double-processed by the oxfordra.net-specific regex', () => {
  const html = renderMarkdown('See https://oxfordra.net/contact for details.');
  const anchorOpens = (html.match(/<a /g) || []).length;
  assert.equal(anchorOpens, 1, 'expected exactly one <a> tag, got: ' + html);
});

test('a bare URL that is the entire message (no trailing punctuation) is untouched', () => {
  const html = renderMarkdown('oxfordra.net/contact');
  assert.match(html, /href="https:\/\/oxfordra\.net\/contact"/);
});
