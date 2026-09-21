// Entity-graph and head-tag guards from the 2026-09-21 oxfordra.net SEO review
// (Google + AI answer engines). Complements seo.test.mjs (2026-09-13 audit).
//
//   E-1  home and about defined the same Organization @id with different content
//   E-2  Organization lacked legalName / contactPoint / knowsAbout; founder only on About
//   E-3  no WebSite node anywhere
//   E-4  Article author/publisher and Service.provider were anonymous nodes, not
//        tied to the Organization by @id (three separate "Oxford" entities)
//   E-5  regression guard: every sitemap page keeps a self-canonical + og:url + og:image
//        (an initial review flagged privacy/terms as missing them; that was a
//        regex attribute-order false positive - the tags were present)
//
// Reads source files (what build-dist.mjs copies verbatim into dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const ORG_ID = 'https://oxfordra.net/#organization';
const GUIDES = [
  'resources/selling-industrial-building-without-a-broker.html',
  'resources/how-industrial-buildings-are-valued.html',
  'resources/1031-exchange-industrial-property-guide.html',
  'resources/industrial-building-sale-document-checklist.html',
];

// Every JSON-LD node on a page, flattened out of arrays and @graph.
function nodes(rel) {
  const out = [];
  for (const [, body] of read(rel).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    const j = JSON.parse(body);
    for (const n of Array.isArray(j) ? j : j['@graph'] ?? [j]) out.push(n);
  }
  return out;
}
const nodeOfType = (rel, type) => nodes(rel).find((n) => n['@type'] === type);

test('E-1 home and about share one identical Organization core (only About adds employee)', () => {
  const home = nodeOfType('index.html', 'Organization');
  const { employee, ...about } = nodeOfType('about.html', 'Organization');
  assert.ok(home && about, 'Organization node missing on home or about');
  assert.equal(home['@id'], ORG_ID);
  assert.ok(Array.isArray(employee) && employee.length > 0, 'About keeps its employee list');
  assert.equal(home.employee, undefined, 'employee stays About-only');
  assert.deepEqual(home, about);
});

test('E-2 Organization carries legalName, founder, contactPoint and knowsAbout', () => {
  const org = nodeOfType('index.html', 'Organization');
  assert.equal(org.legalName, 'Oxford Realty Advisors, LLC');
  assert.equal(org.founder?.['@type'], 'Person');
  assert.equal(org.founder?.name, 'Eric Goldberg');
  assert.equal(org.contactPoint?.['@type'], 'ContactPoint');
  assert.equal(org.contactPoint?.telephone, org.telephone, 'contactPoint phone matches the Organization phone');
  assert.equal(org.contactPoint?.email, org.email, 'contactPoint email matches the Organization email');
  assert.ok(Array.isArray(org.knowsAbout) && org.knowsAbout.length >= 4, 'knowsAbout lists the firm\'s topics');
});

test('E-3 home declares a WebSite node published by the Organization', () => {
  const site = nodeOfType('index.html', 'WebSite');
  assert.ok(site, 'WebSite node missing on home');
  assert.equal(site['@id'], 'https://oxfordra.net/#website');
  assert.equal(site.url, 'https://oxfordra.net/');
  assert.deepEqual(site.publisher, { '@id': ORG_ID });
});

test('E-4 guide Article author/publisher and the Service provider resolve to the Organization @id', () => {
  for (const guide of GUIDES) {
    const article = nodeOfType(guide, 'Article');
    assert.equal(article.author?.['@id'], ORG_ID, `${guide}: author @id`);
    assert.equal(article.publisher?.['@id'], ORG_ID, `${guide}: publisher @id`);
    assert.ok(article.publisher?.logo?.url, `${guide}: publisher keeps its logo (Article rich-result field)`);
  }
  const service = nodeOfType('sell-your-building.html', 'Service');
  assert.equal(service.provider?.['@id'], ORG_ID, 'Service.provider @id');
  assert.equal(service.provider?.['@type'], 'Organization', 'provider is the Organization, not a second RealEstateAgent entity');
});

// Attribute order varies: the minified pages (privacy, terms) write
// <link href=... rel="canonical"> and <meta content=... property="og:image">.
// A regex that assumes one order reports those pages as missing the tags.
function tagAttr(html, tag, keyAttr, keyValue, wantAttr) {
  for (const [t] of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    const attrs = Object.fromEntries([...t.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
    if (attrs[keyAttr] === keyValue) return attrs[wantAttr];
  }
  return undefined;
}

test('E-5 every sitemap page declares a self-canonical, og:url and og:image (any attribute order)', () => {
  const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 19);
  for (const loc of locs) {
    const p = new URL(loc).pathname;
    const file = p === '/' ? 'index.html' : p.endsWith('/') ? `${p.slice(1)}index.html` : `${p.slice(1)}.html`;
    const html = read(file);
    assert.equal(tagAttr(html, 'link', 'rel', 'canonical', 'href'), loc, `${file}: canonical`);
    assert.equal(tagAttr(html, 'meta', 'property', 'og:url', 'content'), loc, `${file}: og:url`);
    assert.match(tagAttr(html, 'meta', 'property', 'og:image', 'content') ?? '', /^https:\/\/oxfordra\.net\//, `${file}: og:image`);
  }
});
