// Hard Invariant 3 build gate: no ACTIVE confidential deal may reach any external
// surface, and none may enter this git-tracked repo in plain text.
//
// Mechanism: scripts/leak-gate-hashes.json holds salted HMACs of the active
// roster's normalized terms (written locally by scripts/leak-gate-hashes.mjs;
// see docs/leak-gate.md). This test hashes windows of everything shipped or
// tracked and compares. It never prints a matched term, and it contains no
// roster term. The CANARY cases use an invented term to prove the scanner can
// still detect a planted hit (a scanner that silently stops matching passes
// every real scan).
//
// Runs after `npm run build` (needs dist/). Fails closed: a missing or
// malformed hash file, a missing dist/, or an unreadable PDF all fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { tokens } from '../../scripts/lib/leak-gate.mjs';
import { activeEntries, buildDenylist, findingLabel, formatFinding, listDist, listTracked, missingRequired, scanFiles, hmac, indexDenylist, rosterDigest, scanFile, scanText, HASH_FILE_VERSION } from '../../scripts/lib/leak-gate.mjs';
import { localRosterStatus } from '../../scripts/leak-gate-hashes.mjs';

// Fail closed if the run is narrowed: a name/skip/only filter (CLI or NODE_OPTIONS) would make this file pass while running one test.
const NARROWING = /--test-(?:name-pattern|skip-pattern|only)\b|--test-only\b/;
if (NARROWING.test(process.env.NODE_OPTIONS || '') || process.execArgv.some((a) => NARROWING.test(a))) {
  throw new Error('leak-gate: refusing to run with a test filter (--test-name-pattern/--test-skip-pattern/--test-only); that would skip the real scan.');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HASH_FILE = path.join(ROOT, 'scripts', 'leak-gate-hashes.json');

// ---- invented canary terms (not real deals, people or companies) ----------
const CANARY = 'Zyxwv Quillborne Holdings'; // long: also substring-matched
const CANARY_SHORT = 'Vrenk Oltaz'; // exactly the substring threshold
const CTX = 'Glimmerfen'; // context-only term
const CTX_REQ = 'Plorbix'; // must co-occur for the context term to count

const salt = crypto.randomBytes(32).toString('hex');
const canaryIdx = indexDenylist(
  buildDenylist(
    [
      { kind: 'always', term: CANARY },
      { kind: 'always', term: CANARY_SHORT },
      { kind: 'context', term: CTX },
      { kind: 'ctxreq', term: CTX_REQ },
    ],
    salt
  )
);
const scan = (name, body) => scanFile(name, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), canaryIdx);

// ---- synthetic PDFs --------------------------------------------------------
function pdf(objs) {
  let out = '%PDF-1.4\n';
  objs.forEach((o, i) => {
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  return Buffer.from(out + 'trailer\n<</Root 1 0 R>>\n%%EOF\n', 'latin1');
}
const streamObj = (dict, body) => {
  const b = deflateSync(Buffer.from(body, 'latin1')).toString('latin1');
  return `<<${dict} /Filter /FlateDecode /Length ${b.length}>>\nstream\n${b}\nendstream`;
};
function literalPdf(text) {
  return pdf([
    '<</Type /Catalog>>',
    streamObj('', `BT\n/F1 12 Tf\n(${text}) Tj\n(filler text for the readable-length floor of this synthetic page) Tj\nET\n`),
  ]);
}
// Skia/Chromium shape: Type0 font + ToUnicode CMap, ONE glyph per Tj with a Td
// between, so the phrase never appears as a string anywhere in the file.
function glyphPdf(text) {
  const chars = [...new Set([...text, ...'abcdefghijklmnopqrstuvwxyz '])];
  const id = new Map(chars.map((c, i) => [c, i + 1]));
  const hex = (n) => n.toString(16).padStart(4, '0');
  const cmap =
    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
    `${chars.length} beginbfchar\n` +
    chars.map((c) => `<${hex(id.get(c))}> <${hex(c.charCodeAt(0))}>`).join('\n') +
    `\nendbfchar\nendcmap\n`;
  const content =
    'BT\n/F5 12 Tf\n' + [...text].map((c) => `<${hex(id.get(c))}> Tj\n7.2 0 Td`).join('\n') + '\nET\n' + 'BT /F5 9 Tf <0001> Tj ET\n'.repeat(60);
  return pdf([
    '<</Type /Catalog>>',
    '<</Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Synthetic /Encoding /Identity-H /ToUnicode 3 0 R>>',
    streamObj('', cmap),
    '<</Font <</F5 2 0 R>>>>',
    streamObj('', content),
  ]);
}
const png = (text) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('....tEXtComment\0' + text + '....', 'latin1'), Buffer.from([0, 1, 2, 255])]);

// ---- canary: the scanner detects what it must -----------------------------
test('canary: plain, case, punctuation and spacing variants all hit', () => {
  for (const v of [CANARY, CANARY.toUpperCase(), 'zyxwv-quillborne  holdings', 'Zyxwv, Quillborne & Holdings', 'ZyxwvQuillborneHoldings', 'zyxwv\nquillborne\nholdings']) {
    assert.deepEqual(scan('page.html', `<p>${v}</p>`).hits, ['always'], 'variant must hit: ' + JSON.stringify(v.length));
  }
  assert.deepEqual(scan('page.html', `We closed ${CANARY_SHORT}.`).hits, ['always']);
});

test('canary: encodings and markup that split the term still hit', () => {
  assert.deepEqual(scan('a.html', '<b>Zyxwv</b> <i>Quill</i><i>borne</i> Holdings').hits, ['always'], 'tags between words and inside a word');
  assert.deepEqual(scan('a.html', '&#90;yxwv Quillborne Holdings').hits, ['always'], 'numeric entity');
  assert.deepEqual(scan('a.json', JSON.stringify({ t: 'Zyxwv Quillborne Holdings' }).replace('Z', '\\u005a')).hits, ['always'], 'json \\u escape');
  assert.deepEqual(scan('a.js', 'x="Zyxwv%20Quillborne%20Holdings"').hits, ['always'], 'percent-encoded');
  assert.deepEqual(scan('a.txt', 'preZyxwvQuillborneHoldingsPost').hits, ['always'], 'inside a longer token (substring path)');
});

test('canary: a term in a FILE NAME or path hits, and the report withholds the path', () => {
  const r = scan('images/zyxwv-quillborne-holdings.png', png('nothing here'));
  assert.ok(r.hits.includes('path:always'));
  assert.equal(r.pathHit, true);
});

test('canary: context terms only count with a co-occurring requirement term', () => {
  assert.deepEqual(scan('a.html', `${CTX} is a pretty word`).hits, [], 'context alone is not a hit');
  assert.deepEqual(scan('a.html', `${CTX_REQ} alone`).hits, [], 'requirement alone is not a hit');
  assert.deepEqual(scan('a.html', `${CTX} near ${CTX_REQ}`).hits, ['context+ctxreq']);
});

test('canary: negative controls do not hit', () => {
  for (const clean of ['Oxford Realty Advisors acquires industrial and flex property.', 'Zyxwv', 'Quillborne Hold', 'Vrenk Olt', '']) {
    assert.deepEqual(scan('clean.html', clean).hits, [], clean);
  }
});

test('canary: PDF text layers are extracted, including one-glyph-per-Tj Chromium output', () => {
  const lit = scan('doc.pdf', literalPdf(`Closed on ${CANARY} in March`));
  assert.ok(lit.hits.includes('always'), 'literal-string PDF');
  assert.deepEqual(lit.problems, []);
  const g = glyphPdf(`closed on ${CANARY.toLowerCase()} in march`);
  assert.equal(g.toString('latin1').toLowerCase().includes('quillborne'), false, 'the glyph PDF must not contain the phrase as bytes');
  const gr = scan('doc.pdf', g);
  assert.ok(gr.hits.some((h) => h.endsWith('always')), 'glyph-per-Tj PDF');
  assert.deepEqual(gr.problems, []);
  assert.deepEqual(scan('doc.pdf', glyphPdf('an ordinary sentence about industrial space with nothing sensitive in it at all')).hits, []);
});

test('canary: PDFs we cannot read fail closed instead of passing', () => {
  const noText = pdf(['<</Type /Catalog>>', streamObj('', '0 0 100 100 re f')]);
  assert.ok(scan('blank.pdf', noText).problems.some((p) => /no readable text/.test(p)));
  const lzw = pdf(['<</Type /Catalog>>', '<</Filter /LZWDecode /Length 4>>\nstream\nabcd\nendstream']);
  assert.ok(scan('odd.pdf', lzw).problems.some((p) => /not decodable/.test(p)));
  const broken = Buffer.from('%PDF-1.4\n1 0 obj\n<</Filter /FlateDecode>>\nstream\nnot zlib data at all\nendstream\nendobj\n', 'latin1');
  assert.ok(scan('broken.pdf', broken).problems.some((p) => /corrupt/.test(p)));
});

test('canary: image metadata and binary strings are scanned (pixels are not)', () => {
  assert.deepEqual(scan('p.png', png(`Comment ${CANARY}`)).hits, ['always']);
  assert.deepEqual(scan('p.png', png('nothing')).hits, []);
});

test('canary: markup the site really uses cannot hide a term (named entities, marks, look-alikes, long terms)', () => {
  const long = 'Quorlin Tessaby Ridge Partners Of Ohio Fund Seven';
  const idx = indexDenylist(buildDenylist([{ kind: 'always', term: "Qentor's Yard" }, { kind: 'always', term: long }], salt));
  const hit = (name, body) => assert.deepEqual(scanFile(name, Buffer.from(body, 'utf8'), idx).hits, ['always'], body.slice(0, 60));
  hit('a.html', 'Qentor&rsquo;s Yard');
  hit('a.html', 'Qentor&#8217;s&nbsp;Yard');
  hit('a.html', 'Qentor&ndash;s&mdash;Yard');
  hit('a.html', 'Qentors&thinsp;Yard&trade;');
  hit('a.html', 'Qentors Yard™');
  hit('a.html', 'Qentors Yard²');
  hit('a.css', '.x:after{content:"\\51 entors Yard"}');
  hit('a.js', 'const s="\\u{51}entors Yard"');
  hit('a.html', 'Qеntors Yard'); // Cyrillic e
  hit('a.html', 'Closing at&nbsp;Qentor&rsquo;s Yard');
  hit('listings.js', 'el.innerHTML = "<b>Qen</b>tors Yard"');
  hit('a.js', 'const showQentorsYardAcquisitionAnnouncementBannerComponentVisibleAndMoreText=1');
  const idx2 = indexDenylist(buildDenylist([{ kind: 'always', term: 'Søren Kestrup Plaza' }, { kind: 'always', term: 'Straße Kilnmoor' }], salt));
  for (const t of ['S&oslash;ren Kestrup Plaza', 'Søren Kestrup Plaza', 'Soren Kestrup Plaza', 'Stra&szlig;e Kilnmoor', 'Strasse Kilnmoor']) {
    assert.deepEqual(scanFile('a.html', Buffer.from(t), idx2).hits, ['always'], t);
  }
  hit('a.txt', long); // 8 tokens: longer than the old fixed window
  hit('a.txt', long.toUpperCase().replaceAll(' ', '_'));
});

test('canary: encodings — UTF-16 text, gzip, and unpackable containers', async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`See ${CANARY} here`, 'utf16le')]);
  assert.deepEqual(scan('a.txt', utf16).hits, ['always'], 'UTF-16LE with BOM');
  const noBom = Buffer.concat([Buffer.from([0x20]), Buffer.from(`See ${CANARY} here`, 'utf16le')]);
  assert.deepEqual(scan('a.bin', noBom).hits, ['always'], 'UTF-16LE at an odd offset');
  const { gzipSync } = await import('node:zlib');
  assert.deepEqual(scan('a.svg.gz', gzipSync(Buffer.from(`<svg><text>${CANARY}</text></svg>`))).hits, ['always'], 'gzip is unpacked');
  assert.ok(scan('a.docx', Buffer.from('PK\u0003\u0004')).problems.length, 'office/zip containers fail closed');
  assert.ok(scan('a.gz', Buffer.from('not gzip')).problems.length, 'undecodable gzip fails closed');
});

test('canary: PDF metadata, indirect font dicts, unmappable fonts and brackets in TJ strings', () => {
  const hexTitle = (t) => '<FEFF' + Buffer.from(t, 'utf16le').swap16().toString('hex') + '>';
  const info = pdf(['<</Type /Catalog>>', `<</Title ${hexTitle(`Memo ${CANARY} 2026`)}>>`, streamObj('', 'BT /F1 12 Tf (' + 'a readable filler sentence about ordinary business '.repeat(2) + ') Tj ET')]);
  assert.deepEqual(scan('m.pdf', info).hits, ['always'], 'UTF-16BE hex /Title');
  const noMap = pdf(['<</Type /Catalog>>', '<</Type /Font /Subtype /Type0 /Encoding /Identity-H>>', streamObj('', 'BT /F5 12 Tf <0001> Tj ET BT /F1 12 Tf (' + 'readable filler words '.repeat(5) + ') Tj ET')]);
  assert.ok(scan('f.pdf', noMap).problems.some((p) => /ToUnicode/.test(p)), 'a Type0 font with no ToUnicode fails closed');
  const bracket = pdf(['<</Type /Catalog>>', streamObj('', `BT /F1 12 Tf [(see ${CANARY.slice(0, 6)}]) -300 (${CANARY.slice(6)} and ${'readable filler '.repeat(4)}) ] TJ ET`)]);
  const br = scan('b.pdf', bracket);
  assert.deepEqual(br.problems, [], 'bracket inside a TJ string does not truncate parsing');
  assert.ok(br.hits.some((h) => h.endsWith('always')), 'a term split around a bracketed TJ string is still found');
});

test('roster semantics mirror the hook: active defaults to true, blank anchors unanchor context terms', () => {
  assert.equal(activeEntries({ d: { always: ['One Two'] } }).length, 1, 'no active key means active');
  assert.equal(activeEntries({ d: { active: false, always: ['One Two'] } }).length, 0);
  assert.equal(activeEntries({ d: { active: 0, always: ['One Two'] } }).length, 0);
  assert.deepEqual(activeEntries({ d: { context: ['Wordy'], context_requires_any: ['', 'anchor'] } }).filter((e) => e.term === 'Wordy').map((e) => e.kind), ['always']);
  assert.deepEqual(activeEntries({ d: { context: ['Wordy'], context_requires_any: ['anchor'] } }).filter((e) => e.term === 'Wordy').map((e) => e.kind), ['context']);
  assert.deepEqual(activeEntries({ _meta: { always: ['x'] }, d: null }), []);
});

test('canary: hash file shape — fail closed on malformed input, never contain a plain canary', () => {
  assert.throws(() => indexDenylist(null), /missing or malformed/);
  assert.throws(() => indexDenylist({ version: HASH_FILE_VERSION, salt: 'zz', entries: [] }), /malformed/);
  assert.throws(() => indexDenylist({ version: 99, salt, entries: [] }), /malformed/);
  const good = buildDenylist([{ kind: 'always', term: CANARY }], salt);
  assert.doesNotThrow(() => indexDenylist(good));
  const mutate = (fn) => {
    const c = JSON.parse(JSON.stringify(good));
    fn(c);
    return c;
  };
  for (const [name, bad] of Object.entries({
    'swapped salt': mutate((c) => (c.salt = 'ab'.repeat(32))),
    'missing selfcheck': mutate((c) => delete c.selfcheck),
    'uppercase hash': mutate((c) => (c.entries[0].h = c.entries[0].h.toUpperCase())),
    'unknown kind': mutate((c) => (c.entries[0].kind = 'Always')),
    'length off by one': mutate((c) => (c.entries[0].len += 1)),
    'entries from another file': mutate((c) => (c.entries[0].h = 'f'.repeat(32))),
    'no length':mutate((c) => delete c.entries[0].len),
    'non-object entry': mutate((c) => (c.entries = ['x'])),
  })) {
    assert.throws(() => indexDenylist(bad), /malformed/, name);
  }
  const built = JSON.stringify(buildDenylist([{ kind: 'always', term: CANARY }], salt));
  for (const part of ['zyxwv', 'quillborne', 'holdings']) assert.ok(!built.toLowerCase().includes(part), 'built file must not leak a term fragment');
});

test('the fast HMAC is byte-identical to crypto.createHmac (the committed file format is plain HMAC-SHA256)', () => {
  for (const s of ['a', '', 'zyxwv quillborne', 'é日本語', 'x'.repeat(500)]) {
    const want = crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(s).digest('hex').slice(0, 32);
    assert.equal(hmac(salt, s), want);
  }
});

test('an empty denylist is valid and scans cleanly (zero active deals)', () => {
  const idx = indexDenylist(buildDenylist([], salt));
  assert.equal(idx.size, 0);
  assert.deepEqual(scanText(CANARY, idx), []);
});

// ---- the real scan ---------------------------------------------------------
function loadDenylist() {
  assert.ok(existsSync(HASH_FILE), 'scripts/leak-gate-hashes.json is missing: the Invariant-3 gate cannot run (fail closed). Restore it from git or regenerate with scripts/leak-gate-hashes.mjs on the roster machine.');
  return JSON.parse(readFileSync(HASH_FILE, 'utf8'));
}

function distFiles() {
  assert.ok(existsSync(path.join(ROOT, 'dist')), 'dist/ is missing: run `npm run build` first (the gate scans the shipped output)');
  return listDist(ROOT);
}

const MUST_SCAN = [
  'netlify/edge-functions/chat.ts',
  'netlify/edge-functions/knowledge-base.json',
  'scripts/meta.md',
  'data/listings.json',
  'data/portfolio.json',
  'Oxford-Realty-Advisors-Overview.pdf',
  'Oxford-Sale-Ready-Checklist.pdf',
  'dist/Oxford-Realty-Advisors-Overview.pdf',
  'dist/Oxford-Sale-Ready-Checklist.pdf',
  'dist/index.html',
];

test('extractor sanity on the real shipped files: a public brand phrase is found in every PDF and in index.html', () => {
  // Public firm name, not a deal. If a PDF rebuild changes the encoding so the
  // extractor goes blind, this fails instead of the real scan quietly passing.
  const idx = indexDenylist(buildDenylist([{ kind: 'always', term: 'Oxford Realty Advisors' }], salt));
  for (const rel of ['Oxford-Realty-Advisors-Overview.pdf', 'Oxford-Sale-Ready-Checklist.pdf', 'dist/Oxford-Realty-Advisors-Overview.pdf', 'dist/Oxford-Sale-Ready-Checklist.pdf', 'dist/index.html']) {
    const r = scanFile(rel, readFileSync(path.join(ROOT, rel)), idx);
    assert.ok(r.hits.includes('always'), `${rel}: extractor found no text`);
    assert.deepEqual(r.problems, [], rel);
  }
});

test('canary: substring matching across words, plurals and look-alike capitals', () => {
  const idx = indexDenylist(buildDenylist([{ kind: 'always', term: 'Foo Holding Group' }, { kind: 'always', term: 'Acme Yard' }], salt));
  const hit = (name, body) => assert.deepEqual(scanFile(name, Buffer.from(body, 'utf8'), idx).hits, ['always'], body.slice(0, 50));
  hit('a.html', 'Foo Holding Groups LLC'); // long term: plain substring, like the hook
  hit('a.html', 'Foo-Holding-GroupY');
  hit('a.html', 'XFoo-Holding-Group'); // a prefix glued onto a short token (the hook catches this too)
  hit('a.html', '<a href="/xfoo-holding-group">link</a>');
  hit('a.html', '<img alt="XFoo Holding Group" src="x.png">');
  hit('a.html', '<meta name="description" content="NewFoo Holding Group">');
  hit('a.html', '<li>Foo</li><li>Holding Group</li>');
  hit('a.html', 'The Acme Yards'); // short term: whole words, plural tolerated
  hit('a.html', 'ACME  YARD');
  assert.deepEqual(scanFile('a.html', Buffer.from('Acmes Yard'), idx).hits, [], 'documented gap: possessive/plural inside the name');
  assert.deepEqual(scanFile('a.html', Buffer.from('Foo Holding and Group'), idx).hits, [], 'documented gap: "and" is not equated with an ampersand or dropped');
  const idx2 = indexDenylist(buildDenylist([{ kind: 'always', term: 'Hezuny Network' }, { kind: 'always', term: 'Nuvon Tower' }], salt));
  for (const t of ['ΗΕZUNY Network', 'HEZUNY NETWORK', 'Νuvon Tower', 'Неzuny Nеtwork', 'Hеzuny Nеtwork', 'Hezuny Network']) {
    assert.ok(scanFile('a.html', Buffer.from(t), idx2).hits.includes('always'), 'look-alike: ' + t);
  }
  assert.ok(scanFile('a.html', Buffer.from('Nuvon Tower'), idx2).hits.includes('always'));
});

test('canary: escaped newlines/tabs in JSON and JS strings, and the second look-alike pass', () => {
  const idx = indexDenylist(buildDenylist([{ kind: 'always', term: 'Foo Holding Group' }], salt));
  const bs = String.fromCharCode(92);
  for (const t of ['Foo' + bs + 'nHolding' + bs + 'tGroup', 'Foo' + bs + 'r' + bs + 'nHolding Group']) {
    assert.ok(scanFile('chat.ts', Buffer.from(JSON.stringify({ k: 1 }) + ' "' + t + '"'), idx).hits.includes('always'), t.length + ' chars');
  }
  // These two only fold on the pass AFTER lowercasing (their capitals are not in the first-pass map).
  assert.deepEqual(tokens('\u051c'), ['w']);
  assert.deepEqual(tokens('\u2c6d'), ['a']);
  for (const [ch, want] of Object.entries({ '\u0261': 'g', '\u2c9e': 'o', '\u2c9f': 'o' })) assert.deepEqual(tokens(ch), [want], 'U+' + ch.codePointAt(0).toString(16));
});

test('canary: PDF literal-string metadata with octal escapes is found', () => {
  const lit = '\\376\\377' + [...`Memo ${CANARY} 2026`].map((c) => '\\000' + c).join('');
  const doc = pdf(['<</Type /Catalog>>', `<</Title (${lit})>>`, streamObj('', 'BT /F1 12 Tf (' + 'a readable filler sentence about ordinary business '.repeat(2) + ') Tj ET')]);
  assert.ok(scan('o.pdf', doc).hits.some((h) => h.endsWith('always')));
});

test('keyed mode: hashes depend on LEAK_GATE_KEY and fail closed without it', () => {
  const saved = process.env.LEAK_GATE_KEY;
  try {
    process.env.LEAK_GATE_KEY = 'k'.repeat(24);
    const keyed = buildDenylist([{ kind: 'always', term: CANARY }], salt, true);
    assert.equal(keyed.keyed, true);
    assert.notEqual(keyed.entries[0].h, buildDenylist([{ kind: 'always', term: CANARY }], salt).entries[0].h, 'keyed hashes differ from unkeyed');
    assert.deepEqual(scanFile('a.html', Buffer.from(CANARY), indexDenylist(keyed)).hits, ['always']);
    process.env.LEAK_GATE_KEY = 'j'.repeat(24);
    assert.throws(() => indexDenylist(keyed), /malformed/, 'wrong key');
    delete process.env.LEAK_GATE_KEY;
    assert.throws(() => indexDenylist(keyed), /keyed|LEAK_GATE_KEY/, 'no key');
  } finally {
    if (saved === undefined) delete process.env.LEAK_GATE_KEY;
    else process.env.LEAK_GATE_KEY = saved;
  }
});

test('roster staleness is detected against a temporary roster (alias handling included)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'leak-gate-roster-'));
  const rosterFile = path.join(dir, 'roster.json');
  const saved = process.env.LEAK_GATE_ROSTER;
  try {
    process.env.LEAK_GATE_ROSTER = rosterFile;
    const committed = buildDenylist([], salt);
    committed.roster_digest = rosterDigest([], salt);
    assert.equal(localRosterStatus(committed).state, 'absent', 'no roster file');
    writeFileSync(rosterFile, JSON.stringify({ _meta: {}, d1: { active: false, always: [CANARY] } }));
    assert.equal(localRosterStatus(committed).state, 'fresh', 'only inactive deals: still fresh');
    writeFileSync(rosterFile, JSON.stringify({ d1: { aliases: [CANARY_SHORT] } }));
    const s = localRosterStatus(committed);
    assert.equal(s.state, 'stale', 'an active deal (alias only) the hash file lacks');
    assert.equal(s.active, 1);
    const entries = activeEntries(JSON.parse(readFileSync(rosterFile, 'utf8')));
    const fresh = buildDenylist(entries, salt);
    fresh.roster_digest = rosterDigest(entries, salt);
    assert.equal(localRosterStatus(fresh).state, 'fresh', 'regenerated file matches');
    writeFileSync(rosterFile, '{ not json');
    assert.equal(localRosterStatus(fresh).state, 'unreadable');
    writeFileSync(rosterFile, JSON.stringify({ d1: { always: [CANARY_SHORT] } }));
    const savedKey = process.env.LEAK_GATE_KEY;
    try {
      delete process.env.LEAK_GATE_KEY;
      assert.equal(localRosterStatus({ ...fresh, keyed: true }).state, 'needs-key', 'a keyed file without the key is never reported fresh');
    } finally {
      if (savedKey !== undefined) process.env.LEAK_GATE_KEY = savedKey;
    }
  } finally {
    if (saved === undefined) delete process.env.LEAK_GATE_ROSTER;
    else process.env.LEAK_GATE_ROSTER = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aliases are hashed as always-terms', () => {
  assert.deepEqual(activeEntries({ d: { aliases: ['Old Name'] } }), [{ kind: 'always', term: 'Old Name' }]);
});

test('the Netlify build command runs this gate (previews and production are gated)', () => {
  const toml = readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const cmd = /^\s*command\s*=\s*"([^"]*)"/m.exec(toml);
  assert.ok(cmd, 'netlify.toml has a build command');
  assert.ok(cmd[1].includes('node --test tests/site/leak-gate.test.mjs'), 'the build command must run the leak-gate test');
  assert.ok(cmd[1].indexOf('build-dist.mjs') < cmd[1].indexOf('leak-gate.test.mjs'), 'the gate must run after dist/ is built');
  assert.ok(cmd[1].trim().endsWith('node --test tests/site/leak-gate.test.mjs'), 'nothing may follow the gate step in the command');
  assert.ok(!/\|\||;|\|(?!\|)|&(?!&)|(?<!&)&$/.test(cmd[1].replace(/&&/g, ' ')), 'the command may only chain with && (no || true, ;, pipes or a lone & that background the step)');
  const live = toml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/context/i.test(live), 'netlify.toml may not use any [context] table or dotted context key (it could override the build command)');
  assert.equal((live.match(/^\s*(?:[\w."'-]+\.)?["']?command["']?\s*=/gm) || []).length, 1, 'exactly one build command key, in any spelling');
  assert.ok(!/NODE_OPTIONS|LEAK_GATE_FAST|--test-(?:name-pattern|skip-pattern|only)/.test(live), 'netlify.toml may not set options that narrow or skip the gate');
});

test('canary: round-3 regressions (short-term plurals, glued/context paths, gzipped PDFs, capital sharp s)', async () => {
  const only = indexDenylist(buildDenylist([{ kind: 'always', term: 'Acme Yard' }], salt));
  const hit = (name, body, idx = only) => assert.deepEqual(scanFile(name, Buffer.from(body), idx).hits.filter((h) => !h.startsWith('path:')), ['always'], body.slice(0, 40));
  hit('a.html', 'The Acme Yards'); // plural with the longest term being short
  hit('a.html', 'The Acme Yardes');
  const longAlias = indexDenylist(buildDenylist([{ kind: 'always', term: 'Foo Holding Group' }], salt));
  assert.ok(scanFile('dist/foo-holding-groupsite.html', Buffer.from('nothing'), longAlias).hits.length, 'a long alias glued into a file name is found');
  assert.deepEqual(scanFile('dist/images/planeview.png', Buffer.alloc(8), indexDenylist(buildDenylist([{ kind: 'always', term: 'Lane' }], salt))).hits, [], 'short terms do not false-positive on glued file names');
  const lines = formatFinding('dist/foo-holding-groupsite.html', scanFile('dist/foo-holding-groupsite.html', Buffer.from('x'), longAlias), longAlias);
  assert.ok(lines.length && lines.every((l) => !/foo|holding|group/i.test(l)), 'a matched file is never named in the finding text');
  const unreadable = formatFinding('dist/glimmer-memo.pdf', { kind: 'pdf', hits: [], problems: ['PDF yielded no readable text'] }, longAlias);
  assert.ok(unreadable.length && unreadable.every((l) => !/glimmer|memo/i.test(l)), 'problem lines also hide the path');
  const label = findingLabel('dist/foo-holding-groupsite.html', longAlias);
  assert.match(label, /^file#[0-9a-f]{8}\.html$/);
  assert.ok(!label.includes('foo'), 'the label never contains the path');
  assert.equal(findingLabel('dist/a.html', longAlias, true), 'dist/a.html');
  assert.match(findingLabel('dist/memo.Vrenkolt', longAlias), /^file#[0-9a-f]{8}$/, 'an unknown extension is not echoed');
  const ctx = indexDenylist(buildDenylist([{ kind: 'context', term: CTX }, { kind: 'ctxreq', term: CTX_REQ }], salt));
  assert.deepEqual(scanFile(`dist/${CTX.toLowerCase()}.html`, Buffer.from(`${CTX_REQ} body`), ctx).hits, ['context+ctxreq'], 'context term in the file name, anchor in the body');
  const { gzipSync } = await import('node:zlib');
  const lzw = pdf(['<</Type /Catalog>>', '<</Filter /LZWDecode /Length 4>>\nstream\nabcd\nendstream']);
  assert.ok(scanFile('x.pdf.gz', gzipSync(lzw), canaryIdx).problems.length, 'a gzipped PDF is still judged as a PDF');
  assert.ok(scanFile('x.docx.gz', gzipSync(Buffer.from('PK')), canaryIdx).problems.length, 'a gzipped container still fails closed');
  const ss = indexDenylist(buildDenylist([{ kind: 'always', term: 'Straße Kilnmoor' }], salt));
  hit('a.html', 'STRAẞE KILNMOOR', ss);
});

test('canary: look-alike glyphs the audit listed all fold to their Latin letters', () => {
  const vectors = { 'Օ': 'o', 'ү': 'y', 'Ԛ': 'q', 'Һ': 'h', 'һ': 'h', 'ɑ': 'a', 'Ꭺ': 'a', 'Ϲ': 'c', 'ϲ': 'c' };
  for (const [ch, want] of Object.entries(vectors)) assert.deepEqual(tokens(`x${ch}x`), [`x${want}x`], 'U+' + ch.codePointAt(0).toString(16));
  const idx = indexDenylist(buildDenylist([{ kind: 'always', term: 'Cobalt Haven Quay' }], salt));
  assert.ok(scanFile('a.html', Buffer.from('Ϲobalt һaven Ԛuay'), idx).hits.includes('always'));
});

test('generator CLI: --keyed writes a keyed file, unkeyed warns, dry scan runs, no term is echoed', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'leak-gate-gen-'));
  const rosterFile = path.join(dir, 'roster.json');
  const outFile = path.join(dir, 'out.json');
  writeFileSync(rosterFile, JSON.stringify({ d1: { active: true, always: [CTX_REQ] } })); // 7 chars: also exercises the short-term warning
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'leak-gate-hashes.mjs'), ...args], {
      env: { ...process.env, LEAK_GATE_KEY: '', LEAK_GATE_ROSTER: rosterFile, LEAK_GATE_OUT: outFile, ...env },
      encoding: 'utf8',
    });
    return { status: r.status, text: (r.stdout || '') + (r.stderr || ''), file: existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null };
  };
  try {
    const plain = run([]);
    assert.equal(plain.status, 0, plain.text);
    assert.equal(plain.file.keyed, false);
    assert.equal(plain.file.entries.length, 1);
    assert.match(plain.text, /UNKEYED/, 'an active unkeyed deal must warn');
    assert.match(plain.text, /shorter than 10/, 'short terms must warn');
    const dry = /dry scan \((\d+) files\)/.exec(plain.text);
    assert.ok(dry && Number(dry[1]) >= 200, 'the dry scan must actually walk dist/ and the tracked files, and report how many');
    assert.ok(!plain.text.toLowerCase().includes(CTX_REQ.toLowerCase()), 'the term is never echoed');
    assert.equal(run(['--check']).status, 0, 'the written file is fresh');

    const key = 'k'.repeat(24);
    const keyed = run(['--keyed'], { LEAK_GATE_KEY: key });
    assert.equal(keyed.status, 0, keyed.text);
    assert.equal(keyed.file.keyed, true, '--keyed must write keyed:true');
    assert.notEqual(keyed.file.entries[0].h, plain.file.entries[0].h, 'keyed hashes differ');
    assert.ok(!/UNKEYED/.test(keyed.text));
    assert.equal(run(['--check'], { LEAK_GATE_KEY: key }).status, 0);
    assert.notEqual(run(['--check']).status, 0, 'a keyed file cannot be checked without the key');
    const noKey = run(['--keyed']);
    assert.notEqual(noKey.status, 0, '--keyed without a key fails');
    assert.ok(!noKey.text.toLowerCase().includes(CTX_REQ.toLowerCase()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanFiles: symlinks are findings, missing files are skipped, required targets are checked', async (t) => {
  const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'leak-gate-tree-'));
  try {
    writeFileSync(path.join(dir, 'a.txt'), `plain ${CANARY} text`);
    writeFileSync(path.join(dir, 'b.txt'), 'nothing here');
    const clean = scanFiles(dir, ['b.txt', 'gone.txt'], canaryIdx);
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.scanned, 1, 'a tracked-but-deleted file is skipped');
    const dirty = scanFiles(dir, ['a.txt'], canaryIdx);
    assert.equal(dirty.findings.length, 1);
    assert.ok(!dirty.findings[0].includes('a.txt'), 'the finding does not name the path');
    assert.deepEqual(missingRequired(dir, ['a.txt', 'b.txt', 'c.txt'], ['a.txt', 'c.txt', 'd.txt']), ['c.txt', 'd.txt']);
    let link = null;
    try {
      symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'));
      link = 'link.txt';
    } catch {
      try {
        mkdirSync(path.join(dir, 'sub'));
        symlinkSync(path.join(dir, 'sub'), path.join(dir, 'junction'), 'junction'); // no privilege needed on Windows
        link = 'junction';
      } catch {
        // fall through
      }
    }
    if (!link) return t.skip('could not create a symlink or junction on this machine: the symlink finding was NOT exercised here (CI covers it)');
    const linked = scanFiles(dir, [link], canaryIdx);
    assert.equal(linked.findings.length, 1);
    assert.match(linked.findings[0], /symlink or submodule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local roster freshness (warns locally; skipped where the roster is absent, e.g. CI)', (t) => {
  const committed = JSON.parse(readFileSync(HASH_FILE, 'utf8'));
  const s = localRosterStatus(committed);
  if (s.state === 'absent') return t.diagnostic('roster not present on this machine (CI): freshness check skipped');
  if (s.state === 'fresh') return t.diagnostic(`hash file matches the local roster (${s.active} active terms)`);
  const why = { stale: 'ARE STALE vs the local roster', unreadable: 'cannot be checked: the local roster file is not valid JSON', 'needs-key': 'cannot be checked: the file is keyed and LEAK_GATE_KEY is not set' }[s.state] || 'are in state ' + s.state;
  const msg = `LEAK-GATE HASHES ${why}: run \`node scripts/leak-gate-hashes.mjs\` and commit scripts/leak-gate-hashes.json`;
  console.warn('\n[leak-gate] WARNING: ' + msg + '\n');
  t.diagnostic(msg);
  if (process.env.LEAK_GATE_STRICT_ROSTER === '1') assert.fail(msg);
});

test('no active confidential-deal term appears in dist/, tracked source, data, edge functions or PDFs', (t) => {
  // Only the mutation runner sets this, for cases the unit-level tests catch (keeps that job inside its time limit). The Netlify
  // command test below forbids it in netlify.toml.
  if (process.env.LEAK_GATE_FAST === '1') return t.skip('LEAK_GATE_FAST=1: real-tree scan skipped (mutation runner only)');
  const idx = indexDenylist(loadDenylist());
  const files = [...new Set([...distFiles(), ...listTracked(ROOT), ...MUST_SCAN.filter((f) => !f.startsWith('dist/'))])];
  const tracked = files.filter((f) => !f.startsWith('dist/'));
  assert.ok(tracked.length >= 200, `only ${tracked.length} tracked files found: the file listing is broken, so the scan would be vacuous`);
  assert.deepEqual(missingRequired(ROOT, files, MUST_SCAN), [], 'required scan targets are missing');

  // Matched files are shown only as file#<fingerprint><ext> (see findingLabel); LEAK_GATE_SHOW_PATHS=1 prints real paths locally.
  const { findings, counts } = scanFiles(ROOT, files, idx, process.env.LEAK_GATE_SHOW_PATHS === '1');
  t.diagnostic(
    `scanned ${files.length} files vs ${idx.size} denylist hashes (${counts.text} text, ${counts.pdf} pdf, ${counts.image} image, ${counts.binary} binary). ` +
      'Images: file names and embedded metadata strings only; pixel content (text drawn into images) is NOT scanned, OCR is out of scope.'
  );
  assert.deepEqual(
    findings,
    [],
    'Invariant 3 breach or unprovable file. Matched files are shown as file#<fingerprint><ext> only; re-run locally with LEAK_GATE_SHOW_PATHS=1 to see paths. Remove the content and rebuild; see docs/leak-gate.md.'
  );
  void statSync;
});
