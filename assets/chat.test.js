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

// ---- Characterization: pin current renderMarkdown output -------------------
// renderMarkdown is the widget's sanitizer: its output goes straight into
// innerHTML. These cases pin today's exact output for links, bold/italic, lists,
// paragraphs, escaping and bare-email autolinking, so a change to any pass
// (e.g. the email autolinker) cannot silently alter the rest.
const CHARACTERIZATION = [
  ['bold + italic', 'Hello **world** and *it*', '<p>Hello <strong>world</strong> and <em>it</em></p>'],
  ['list then paragraph', '- one\n- two\n\npara', '\n<ul><li>one</li><li>two</li></ul><p>para</p>'],
  ['line break + paragraphs', 'line1\nline2\n\np2', '<p>line1<br>line2</p><p>p2</p>'],
  ['HTML, ampersand and quotes are escaped', '<script>alert(1)</script> & "q" \'s',
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s</p>'],
  ['https [label](url) link', '[x](https://example.com/a)',
    '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">x</a></p>'],
  ['quote in a label cannot break out of the anchor', '[a" onmouseover="x](https://e.com)',
    '<p><a href="https://e.com" target="_blank" rel="noopener noreferrer">a&quot; onmouseover=&quot;x</a></p>'],
  ['javascript: URL is not linked', '[x](javascript:alert(1))', '<p>[x](javascript:alert(1))</p>'],
  ['quote in a mailto href cannot add an attribute', '[x](mailto:a@b.com" onclick="x)',
    '<p>[x](mailto:<a href="mailto:a@b.com">a@b.com</a>&quot; onclick=&quot;x)</p>'],
  ['bare https URL with trailing period', 'see https://a.com/b. ok',
    '<p>see <a href="https://a.com/b" target="_blank" rel="noopener noreferrer">https://a.com/b</a>. ok</p>'],
  ['bare email, trailing period stays outside', 'email ggoldberg@oxfordra.net.',
    '<p>email <a href="mailto:ggoldberg@oxfordra.net">ggoldberg@oxfordra.net</a>.</p>'],
  ['email inside bold', '**a@b.com**', '<p><strong><a href="mailto:a@b.com">a@b.com</a></strong></p>'],
  ['email inside a list item', '- a@b.com\n- c', '\n<ul><li><a href="mailto:a@b.com">a@b.com</a></li><li>c</li></ul>\n'],
  ['entity-encoded angle brackets around an email', '&lt;x@y.com&gt;',
    '<p>&amp;lt;<a href="mailto:x@y.com">x@y.com</a>&amp;gt;</p>'],
  ['raw angle brackets around an email', '<x@y.com>', '<p>&lt;<a href="mailto:x@y.com">x@y.com</a>&gt;</p>'],
  ['attribute-breakout text after a bare email stays escaped', 'x@y.com"><img src=x onerror=1>',
    '<p><a href="mailto:x@y.com">x@y.com</a>&quot;&gt;&lt;img src=x onerror=1&gt;</p>'],
  ['bare email between two https anchors', '[A](https://a.com) b@c.com [D](https://d.com)',
    '<p><a href="https://a.com" target="_blank" rel="noopener noreferrer">A</a> <a href="mailto:b@c.com">b@c.com</a> ' +
    '<a href="https://d.com" target="_blank" rel="noopener noreferrer">D</a></p>'],
];

for (const [name, input, expected] of CHARACTERIZATION) {
  test(`characterization: ${name}`, () => {
    assert.equal(renderMarkdown(input), expected);
  });
}
