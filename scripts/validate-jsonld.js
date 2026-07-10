#!/usr/bin/env node
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/validate-jsonld.js <path/to/file.html>');
  process.exit(1);
}

const html = fs.readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];

if (blocks.length === 0) {
  console.error('No JSON-LD blocks found in ' + file);
  process.exit(1);
}

let failed = false;
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
