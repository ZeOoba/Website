#!/usr/bin/env node
'use strict';
const fs = require('fs');

// One definition of "a JSON-LD script tag", shared with verify-jsonld.mjs so the
// page census and the parser can never disagree. Attribute order and quote
// style are free: `<script id="x" type="application/ld+json">` counts. The
// leading \s keeps `data-type="application/ld+json"` from matching, and the
// value must end right after `json`, so `application/ld+json5` does not.
const JSONLD_OPEN_SOURCE = String.raw`<script\b[^>]*\stype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json(?=[\s>/]))[^>]*>`;
const jsonLdOpenTags = () => new RegExp(JSONLD_OPEN_SOURCE, 'gi');
const jsonLdBlocks = () => new RegExp(JSONLD_OPEN_SOURCE + String.raw`([\s\S]*?)<\/script>`, 'gi');

// A block inside an HTML comment is invisible to search engines, so it must not
// count as present (or be parsed as if it shipped). One left-to-right pass:
// script/style contents are kept verbatim (a "<!--" inside a JSON string is
// data, not a comment opener), and `<!-->` / `<!--->` close immediately, as the
// HTML tokenizer treats them; an unclosed `<!--` hides the rest of the file.
const stripHtmlComments = (html) =>
  html.replace(/(<(script|style)\b[^>]*>[\s\S]*?<\/\2\s*>)|<!--(?:>|->|[\s\S]*?(?:-->|$))/gi, (m, rawText) => rawText ?? '');

module.exports = { JSONLD_OPEN_SOURCE, jsonLdOpenTags, jsonLdBlocks, stripHtmlComments };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/validate-jsonld.js <path/to/file.html>');
    process.exit(1);
  }

  const html = stripHtmlComments(fs.readFileSync(file, 'utf8'));
  const opened = [...html.matchAll(jsonLdOpenTags())].length;
  const blocks = [...html.matchAll(jsonLdBlocks())];

  if (opened === 0) {
    console.error('No JSON-LD blocks found in ' + file);
    process.exit(1);
  }

  let failed = false;
  // A JSON-LD tag the block pattern could not pair with a </script> was never
  // parsed. Fail rather than report the blocks that did parse as the whole page.
  if (blocks.length !== opened) {
    failed = true;
    console.error('JSON-LD block count mismatch — ' + opened + ' tag(s) opened, ' + blocks.length + ' parsed — ' + file);
  }

  blocks.forEach(function (match, i) {
    const raw = match[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const type = parsed['@type'] || '(no @type)';
      console.log('[' + (i + 1) + '/' + blocks.length + '] OK — ' + type + ' — ' + file);
    } catch (err) {
      failed = true;
      console.error('[' + (i + 1) + '/' + blocks.length + '] INVALID JSON — ' + err.message + ' — ' + file);
    }
  });

  process.exit(failed ? 1 : 0);
}
