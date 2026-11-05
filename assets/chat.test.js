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
  // Attribute breakout via a URL nested inside an href an earlier pass produced
  // (REFUTE round 1, D1): the bare-URL and oxfordra.net passes' lookbehind let
  // '=' through, and [^\s<]+ swallowed the href's closing quote.
  '[x](https://e.com/?u=https://x/onmouseover=window.__pwn=1//)',
  'https://e.com/?u=oxfordra.net/onmouseover=window.__pwn=1//',
  '[x](https://e.com/?u=oxfordra.net/onmouseover=window.__pwn=1//)',
  '[Email us](mailto:x@y.com?body=https://e.com)',
  '[x](https://e.com/?u=https://x/style=position:fixed;inset:0//)',
  '[x](https://e.com/?u=https://x/style=position:fixed;inset:0;z-index:2147483647;background:red;x:)',
  '[x](https://e.com/?u=https://x/onmouseover=window.__pwn=1//a@b.com)',
  '[see https://e.com and x@y.com](mailto:x@y.com)',
  '[see oxfordra.net/x](https://oxfordra.net/x)',
  '[x](https://e.com/?next=http://y/?z=oxfordra.net/a=b@c.de)',
  // A line terminator inside a link label: the anchor pattern must span it, or
  // that anchor is not skipped and D1 re-opens (REFUTE round 2: anchor bodies
  // `.*?` and `[^\n]*?` both survived the rest of this suite).
  '[a\nb](https://e.com/?u=https://x/onmouseover=window.__pwn=1//)',
  '[a\rb](https://e.com/?u=https://x/onmouseover=window.__pwn=1//)',
  '[a\u2028b](https://e.com/?u=https://x/style=position:fixed;inset:0//)',
  '[a\u2029b](https://e.com/?u=https://x/onmouseover=window.__pwn=1//)',
];

// JSON.stringify leaves U+2028/U+2029 raw; escape them so the test names stay readable.
const showInput = (s) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
for (const input of HOSTILE_INPUTS) {
  test(`sanitizer invariant holds for ${showInput(input)}`, () => {
    const html = renderMarkdown(input);
    assertAllowedAttributes(html);
    assertSafeMarkup(html);
  });
}

// ---- Attribute allow-set, judged the way a browser tokenizes tags -----------
// A substring test cannot tell an attribute from text inside an href (the URLs
// above legitimately contain "onmouseover=" as href text). So the check below
// tokenizes start/end tags with the WHATWG tokenizer states for tags (tag name,
// before/after attribute name, attribute name, before attribute value, double-,
// single- and unquoted values, after a quoted value, self-closing start tag).
// It only has to be faithful for what renderMarkdown can emit: user '<' is
// escaped first, so every '<' in its output is one of our own tags (no
// comments, no raw-text elements). Character references are left undecoded.
function tokenizeTags(html) {
  const tags = [];
  const n = html.length;
  const ws = (c) => c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' ';
  const alpha = (c) => c !== undefined && /[A-Za-z]/.test(c);
  const lower = (c) => (c >= 'A' && c <= 'Z' ? c.toLowerCase() : c); // ASCII-only, as the tokenizer does
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    let p = lt + 1;
    const end = html[p] === '/';
    if (end) p++;
    if (!alpha(html[p])) {
      if (html[p] === '!' || html[p] === '?' || (end && p < n && html[p] !== '>')) {
        const gt = html.indexOf('>', p); // comment / bogus comment: skipped to '>'
        i = gt === -1 ? n : gt + 1;
      } else {
        i = end && html[p] === '>' ? p + 1 : lt + 1; // '</>' is dropped; a lone '<' is text
      }
      continue;
    }
    const tag = { end, name: '', attrs: [] };
    let attr = null;
    let state = 'tagName';
    let closed = false;
    const newAttr = (first) => { attr = { name: first, value: '' }; tag.attrs.push(attr); };
    for (; p < n && !closed; p++) {
      const c = html[p];
      switch (state) {
        case 'tagName':
          if (ws(c)) state = 'beforeAttrName';
          else if (c === '/') state = 'selfClosing';
          else if (c === '>') closed = true;
          else tag.name += lower(c);
          break;
        case 'beforeAttrName':
          if (ws(c)) break;
          if (c === '/' || c === '>') { state = 'afterAttrName'; p--; break; }
          if (c === '=') { newAttr('='); state = 'attrName'; break; }
          newAttr(''); state = 'attrName'; p--; break;
        case 'attrName':
          if (ws(c) || c === '/' || c === '>') { state = 'afterAttrName'; p--; break; }
          if (c === '=') { state = 'beforeAttrValue'; break; }
          attr.name += lower(c); break;
        case 'afterAttrName':
          if (ws(c)) break;
          if (c === '/') { state = 'selfClosing'; break; }
          if (c === '=') { state = 'beforeAttrValue'; break; }
          if (c === '>') { closed = true; break; }
          newAttr(''); state = 'attrName'; p--; break;
        case 'beforeAttrValue':
          if (ws(c)) break;
          if (c === '"') { state = 'dq'; break; }
          if (c === "'") { state = 'sq'; break; }
          if (c === '>') { closed = true; break; }
          state = 'uq'; p--; break;
        case 'dq':
          if (c === '"') state = 'afterQuoted'; else attr.value += c;
          break;
        case 'sq':
          if (c === "'") state = 'afterQuoted'; else attr.value += c;
          break;
        case 'uq':
          if (ws(c)) state = 'beforeAttrName';
          else if (c === '>') closed = true;
          else attr.value += c;
          break;
        case 'afterQuoted':
          if (ws(c)) { state = 'beforeAttrName'; break; }
          if (c === '/') { state = 'selfClosing'; break; }
          if (c === '>') { closed = true; break; }
          state = 'beforeAttrName'; p--; break;
        case 'selfClosing':
          if (c === '>') { closed = true; break; }
          state = 'beforeAttrName'; p--; break;
      }
    }
    if (!closed) break; // EOF inside a tag: the browser drops the tag
    tags.push(tag);
    i = p;
  }
  return tags;
}

// The only markup renderMarkdown may emit: <a> with href/target/rel (exact
// target and rel values, http(s)/mailto href with no markup inside it), and
// attribute-free p/strong/em/ul/li/br. Anchor nesting depth never above 1.
const ALLOWED_TAGS = new Set(['a', 'p', 'strong', 'em', 'ul', 'li', 'br']);
const ALLOWED_A_ATTRS = { target: /^_blank$/, rel: /^noopener noreferrer$/, href: /^(?:https?:\/\/|mailto:)[^<>"]*$/ };
function attributeProblems(html) {
  const problems = [];
  let depth = 0;
  for (const tag of tokenizeTags(html)) {
    if (!ALLOWED_TAGS.has(tag.name)) problems.push(`disallowed tag <${tag.end ? '/' : ''}${tag.name}>`);
    if (tag.end) {
      if (tag.attrs.length) problems.push(`attributes on </${tag.name}>: ${tag.attrs.map((a) => a.name).join(' ')}`);
      if (tag.name === 'a' && --depth < 0) problems.push('unbalanced </a>');
      continue;
    }
    for (const { name, value } of tag.attrs) {
      const allowed = tag.name === 'a' && Object.hasOwn(ALLOWED_A_ATTRS, name);
      if (!allowed) problems.push(`disallowed attribute ${JSON.stringify(name)}=${JSON.stringify(value)} on <${tag.name}>`);
      else if (!ALLOWED_A_ATTRS[name].test(value)) problems.push(`bad ${name} value ${JSON.stringify(value)}`);
    }
    if (tag.name === 'a' && ++depth > 1) problems.push('anchor nesting depth above 1');
  }
  if (depth > 0) problems.push('unbalanced <a>');
  return problems;
}
function assertAllowedAttributes(html) {
  const problems = attributeProblems(html);
  assert.deepEqual(problems, [], `${problems.join('; ')}\n  in: ${html}`);
}

test('attribute checker is not vacuous: it rejects the round-1 breakout markup and accepts clean output', () => {
  // Exact renderMarkdown output for '[x](https://e.com/?u=https://x/onmouseover=window.__pwn=1//)' before the fix.
  const broken = '<p><a href="https://e.com/?u=<a href="https://x/onmouseover=window.__pwn=1//"" target="_blank" ' +
    'rel="noopener noreferrer">https://x/onmouseover=window.__pwn=1//"</a> target="_blank" rel="noopener noreferrer">x</a></p>';
  const names = tokenizeTags(broken)[1].attrs.map((a) => a.name);
  assert.deepEqual(names, ['href', 'https:', 'x', 'onmouseover', 'target', 'rel'], 'tokenizer must surface the injected handler');
  assert.throws(() => assertAllowedAttributes(broken), /bad href value .*disallowed attribute "onmouseover"/);
  assert.throws(() => assertAllowedAttributes('<p><a href="https://e.com" style="position:fixed">x</a></p>'), /disallowed attribute "style"/);
  assert.throws(() => assertAllowedAttributes('<p><a href="https://e.com">a<a href="https://f.com">b</a></a></p>'), /nesting depth/);
  assert.throws(() => assertAllowedAttributes('<p><a href="javascript:alert(1)">x</a></p>'), /bad href/);
  assert.throws(() => assertAllowedAttributes('<p class="x">t</p>'), /disallowed attribute "class"/);
  assertAllowedAttributes('<p><a href="https://e.com/?q=a&amp;b" target="_blank" rel="noopener noreferrer">x</a> ' +
    '<a href="mailto:a@b.com">a@b.com</a><br><strong>b</strong></p>');
});

// Exact expected output: one anchor, the whole URL kept inside one href, the
// "onmouseover=" / "style=" text staying inert href text.
const BREAKOUT_CASES = [
  ['P-a: URL inside a [label](url) href (bare-URL pass)',
    '[x](https://e.com/?u=https://x/onmouseover=window.__pwn=1//)',
    '<p><a href="https://e.com/?u=https://x/onmouseover=window.__pwn=1//" target="_blank" rel="noopener noreferrer">x</a></p>'],
  ['P-b: oxfordra.net path inside a bare URL href (oxfordra.net pass)',
    'https://e.com/?u=oxfordra.net/onmouseover=window.__pwn=1//',
    '<p><a href="https://e.com/?u=oxfordra.net/onmouseover=window.__pwn=1//" target="_blank" rel="noopener noreferrer">' +
    'https://e.com/?u=oxfordra.net/onmouseover=window.__pwn=1//</a></p>'],
  ['P-c: URL inside a mailto href',
    '[Email us](mailto:x@y.com?body=https://e.com)',
    '<p><a href="mailto:x@y.com?body=https://e.com" target="_blank" rel="noopener noreferrer">Email us</a></p>'],
  ['style= overlay variant',
    '[x](https://e.com/?u=https://x/style=position:fixed;inset:0//)',
    '<p><a href="https://e.com/?u=https://x/style=position:fixed;inset:0//" target="_blank" rel="noopener noreferrer">x</a></p>'],
  ['oxfordra.net path inside a [label](url) href',
    '[x](https://e.com/?u=oxfordra.net/onmouseover=window.__pwn=1//)',
    '<p><a href="https://e.com/?u=oxfordra.net/onmouseover=window.__pwn=1//" target="_blank" rel="noopener noreferrer">x</a></p>'],
];

for (const [name, input, expected] of BREAKOUT_CASES) {
  test(`attribute breakout blocked: ${name}`, () => {
    const html = renderMarkdown(input);
    assertAllowedAttributes(html);
    assert.equal(anchorCount(html), 1, html);
    assert.equal(html, expected);
  });
}

// C2b: autolinkable text inside a link's label or href stays where it is.
test('C2b: a URL and an email inside a mailto link label stay label text in one anchor', () => {
  const html = renderMarkdown('[see https://e.com and x@y.com](mailto:x@y.com)');
  assert.equal(anchorCount(html), 1, html);
  assert.equal(html, '<p><a href="mailto:x@y.com" target="_blank" rel="noopener noreferrer">see https://e.com and x@y.com</a></p>');
});

test('C2b: a URL inside a mailto href gives one anchor and no anchor inside the href', () => {
  const html = renderMarkdown('[Email us](mailto:x@y.com?body=https://e.com)');
  assert.equal(anchorCount(html), 1, html);
  for (const tag of tokenizeTags(html)) {
    for (const a of tag.attrs) assert.doesNotMatch(a.value, /<a\b/, `anchor inside ${a.name}: ${html}`);
  }
});

// Formerly a todo (P2-7): the oxfordra.net pass re-linked an oxfordra.net/ path
// inside a [label](url) label. Fixed by running every autolink pass outside
// existing anchors only.
test('P2-7: oxfordra.net/ path inside a link label is not re-linked', () => {
  const html = renderMarkdown('[see oxfordra.net/x](https://oxfordra.net/x)');
  assertSafeMarkup(html);
  assertAllowedAttributes(html);
  assert.equal(html, '<p><a href="https://oxfordra.net/x" target="_blank" rel="noopener noreferrer">see oxfordra.net/x</a></p>');
});

// ---- Lookbehind context outside anchors is preserved (matches main) ---------
// The shared helper skips existing anchors but still runs each pass pattern on
// the full string, so a pass's lookbehind sees the real preceding character
// (e.g. the '>' that ends an anchor). Plain segment splitting would lose that
// context and change these outputs. Pinned to main's exact output.
const CONTEXT_CASES = [
  ['URL glued to the end of a link stays text', '[x](https://a.com)https://b.com',
    '<p><a href="https://a.com" target="_blank" rel="noopener noreferrer">x</a>https://b.com</p>'],
  ['oxfordra.net path glued to the end of a link stays text', '[x](https://a.com)oxfordra.net/y',
    '<p><a href="https://a.com" target="_blank" rel="noopener noreferrer">x</a>oxfordra.net/y</p>'],
  ['oxfordra.net path after "/" stays text', 'ftp://oxfordra.net/x', '<p>ftp://oxfordra.net/x</p>'],
  ['URL after "/" stays text', 'see/https://e.com', '<p>see/https://e.com</p>'],
  ['email glued to the end of a link still autolinks', '[x](https://a.com)a@b.com',
    '<p><a href="https://a.com" target="_blank" rel="noopener noreferrer">x</a><a href="mailto:a@b.com">a@b.com</a></p>'],
];

for (const [name, input, expected] of CONTEXT_CASES) {
  test(`context preserved: ${name}`, () => {
    assert.equal(renderMarkdown(input), expected);
  });
}
