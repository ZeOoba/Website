/**
 * build-kb.mjs — Knowledge base builder for the ORA chat assistant.
 *
 * Reads every public HTML page from the site directory, strips chrome
 * (nav, footer, scripts, styles), and emits a single JSON artifact for the
 * Edge Function to inject into the system prompt.
 *
 * Run via: node scripts/build-kb.mjs
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const META_PATH = path.join(ROOT, 'scripts', 'meta.md');
const OUTPUT_PATH = path.join(ROOT, 'netlify', 'edge-functions', 'knowledge-base.json');

// Pages we surface to the assistant. Excludes pages that would only confuse the model
// (tenant-application, application-received, privacy/terms — those are functional, not informational).
const PAGES = [
  { file: 'index.html',           url: 'https://oxfordra.net/',                   title: 'Home' },
  { file: 'about.html',            url: 'https://oxfordra.net/about',              title: 'The Firm' },
  { file: 'portfolio.html',        url: 'https://oxfordra.net/portfolio',          title: 'Portfolio' },
  { file: 'track-record.html',     url: 'https://oxfordra.net/track-record',       title: 'Track Record' },
  { file: 'what-we-see.html',      url: 'https://oxfordra.net/what-we-see',        title: 'How Oxford Sees Small Industrial' },
  { file: 'for-brokers.html',      url: 'https://oxfordra.net/for-brokers',        title: 'Broker Network — Submit a Deal' },
  { file: 'available-space.html',  url: 'https://oxfordra.net/available-space',    title: 'Available Space' },
  { file: 'tenant-resources.html', url: 'https://oxfordra.net/tenant-resources',   title: 'Tenant Resources' },
  { file: 'contact.html',          url: 'https://oxfordra.net/contact',            title: 'Contact' },
];

/** Strip HTML tags and collapse whitespace; preserve heading + paragraph breaks. */
function htmlToText(html) {
  // Drop scripts, styles, nav, header, footer
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')   // chatbot doesn't need to read forms verbatim
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<picture[\s\S]*?<\/picture>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Convert headings + paragraphs + list items to text with line breaks.
  s = s
    .replace(/<\/(h[1-6]|p|li|tr|td|th|div|section|article|blockquote|cite)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '');             // strip remaining tags

  // Decode the few HTML entities that show up in the static pages.
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&hellip;/g, '…');

  // Collapse runs of whitespace.
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

async function main() {
  const meta = await fs.readFile(META_PATH, 'utf8');
  const pages = [];

  // Page 0: hand-curated meta
  pages.push({
    url: 'https://oxfordra.net/_meta',
    title: 'Firm Facts (curated)',
    content: meta.trim(),
  });

  for (const p of PAGES) {
    const fullPath = path.join(ROOT, p.file);
    let raw;
    try {
      raw = await fs.readFile(fullPath, 'utf8');
    } catch {
      console.error(`[build-kb] WARN: missing ${p.file}, skipping`);
      continue;
    }
    const text = htmlToText(raw);
    if (text.length < 80) {
      console.error(`[build-kb] WARN: ${p.file} produced only ${text.length} chars after strip`);
      continue;
    }
    pages.push({ url: p.url, title: p.title, content: text });
  }

  pages.sort((a, b) => a.url.localeCompare(b.url));

  const totalChars = pages.reduce((n, p) => n + p.content.length, 0);
  if (pages.length < 5 || totalChars < 5000) {
    console.error(`[build-kb] FAIL: pages=${pages.length}, chars=${totalChars} — KB too small`);
    process.exit(1);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    version: '1.0',
    pages,
  };
  const json = JSON.stringify(out, null, 2);
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, json, 'utf8');

  const sha = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  console.log(`[build-kb] OK pages=${pages.length} chars=${totalChars} sha256=${sha}`);
  console.log(`[build-kb] wrote ${OUTPUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
