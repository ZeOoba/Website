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

// ---- [text](mailto:...) must produce exactly one anchor --------------------
// The bare-email autolinker ran over the markup the [label](url) pass had
// already produced, re-matching the address inside href="mailto:..." (and in
// the label) and corrupting it into a nested <a>.
const anchorCount = (html) => (html.match(/<a\b/g) || []).length;

// Structural sanitizer invariant: after removing the exact markup renderMarkdown
// is allowed to emit, no '<' and no raw '"' may remain, and no anchor may open
// inside another anchor.
const ALLOWED_MARKUP = /<a href="(?:https?:\/\/|mailto:)[^"<>]*"(?: target="_blank" rel="noopener noreferrer")?>|<\/a>|<\/?(?:p|strong|em|ul|li)>|<br>/g;
function assertSafeMarkup(html) {
  const residue = html.replace(ALLOWED_MARKUP, '');
  assert.doesNotMatch(residue, /[<"]/, 'unexpected raw markup in: ' + html);
  let depth = 0;
  for (const tag of html.match(/<a\b|<\/a>/g) || []) {
    depth += tag === '</a>' ? -1 : 1;
    assert.ok(depth === 0 || depth === 1, 'nested or unbalanced <a> in: ' + html);
  }
  assert.equal(depth, 0, 'unbalanced <a> in: ' + html);
}

test('[Email us](mailto:...) renders exactly one anchor with the mailto href', () => {
  const html = renderMarkdown('[Email us](mailto:ggoldberg@oxfordra.net)');
  assert.equal(anchorCount(html), 1, html);
  assert.equal(html, '<p><a href="mailto:ggoldberg@oxfordra.net" target="_blank" rel="noopener noreferrer">Email us</a></p>');
});

test('[address](mailto:address) renders exactly one anchor', () => {
  const html = renderMarkdown('[ggoldberg@oxfordra.net](mailto:ggoldberg@oxfordra.net)');
  assert.equal(anchorCount(html), 1, html);
  assert.equal(html, '<p><a href="mailto:ggoldberg@oxfordra.net" target="_blank" rel="noopener noreferrer">ggoldberg@oxfordra.net</a></p>');
});

test('bare email still autolinks to one mailto anchor with the trailing period outside', () => {
  const html = renderMarkdown('email ggoldberg@oxfordra.net.');
  assert.equal(anchorCount(html), 1, html);
  assert.match(html, /<a href="mailto:ggoldberg@oxfordra\.net">ggoldberg@oxfordra\.net<\/a>\.<\/p>$/);
});

test('an email inside a bare URL query string does not become a nested anchor', () => {
  const html = renderMarkdown('https://oxfordra.net/x?e=a@b.com');
  assert.equal(anchorCount(html), 1, html);
  assert.equal(html, '<p><a href="https://oxfordra.net/x?e=a@b.com" target="_blank" rel="noopener noreferrer">https://oxfordra.net/x?e=a@b.com</a></p>');
});

test('javascript:/data: text in a label is inert text inside a single anchor', () => {
  const js = renderMarkdown('[javascript:a@b.com](mailto:a@b.com)');
  assert.equal(js, '<p><a href="mailto:a@b.com" target="_blank" rel="noopener noreferrer">javascript:a@b.com</a></p>');
  const data = renderMarkdown('[data:x@y.com](https://e.com)');
  assert.equal(data, '<p><a href="https://e.com" target="_blank" rel="noopener noreferrer">data:x@y.com</a></p>');
});

test('bare emails around a mailto link each get one anchor; the mailto link is not re-linked', () => {
  const html = renderMarkdown('a@b.com and [c](mailto:c@d.com) and e@f.com');
  assert.equal(html, '<p><a href="mailto:a@b.com">a@b.com</a> and ' +
    '<a href="mailto:c@d.com" target="_blank" rel="noopener noreferrer">c</a> and <a href="mailto:e@f.com">e@f.com</a></p>');
});

const HOSTILE_INPUTS = [
  '[Email us](mailto:ggoldberg@oxfordra.net)',
  '[ggoldberg@oxfordra.net](mailto:ggoldberg@oxfordra.net)',
  '[x](mailto:a@b.com" onclick="x)',
  '[x](mailto:a@b.com"onclick="x)',
  '[a" onmouseover="x@y.com](mailto:x@y.com)',
  '[javascript:a@b.com](mailto:a@b.com)',
  '[data:text/html,x@y.com](mailto:x@y.com)',
  '[x](javascript:alert(1)) a@b.com',
  '[x](data:text/html;base64,PHNjcmlwdD4=) a@b.com',
  '&lt;a href=&quot;x&quot;&gt;a@b.com&lt;/a&gt;',
  '<a href="mailto:a@b.com">a@b.com</a>',
  '</a><a href=x>a@b.com',
  'x@y.com"><img src=x onerror=1>',
  '**[Mail](mailto:a@b.com)** and - item',
  '- [Mail](mailto:a@b.com)\n- b@c.com',
  '[A](mailto:a@b.com)[B](mailto:b@c.com)',
  'https://oxfordra.net/x?e=a@b.com and [m](mailto:m@n.com)',
];

for (const input of HOSTILE_INPUTS) {
  test(`sanitizer invariant holds for ${JSON.stringify(input)}`, () => {
    assertSafeMarkup(renderMarkdown(input));
  });
}

// Known PRE-EXISTING defect, out of TA-1 scope (logged for P2-7): the bare
// oxfordra.net autolinker (not the email pass) still re-links an oxfordra.net/
// path inside a [label](url) label. Kept as a todo so it is visible, not a
// TA-1 pass criterion.
test('KNOWN (P2-7): oxfordra.net/ path inside a link label is not re-linked', { todo: 'P2-7: oxfordra.net pass, not the email pass' }, () => {
  assertSafeMarkup(renderMarkdown('[see oxfordra.net/x](https://oxfordra.net/x)'));
});
