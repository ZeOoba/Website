'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('geocode() parses Census matches to 5-decimal lat/lng and passes the address through', async () => {
  const { geocode } = await import('../../scripts/geocode-listing.mjs');
  let seen;
  const fake = async (u) => {
    seen = u;
    return { ok: true, json: async () => ({ result: { addressMatches: [{ matchedAddress: '2203 NORTHWOOD DR, SALISBURY, MD, 21801', coordinates: { x: -75.580136622261, y: 38.399554742826 } }] } }) };
  };
  const hits = await geocode('2203 Northwood Dr, Salisbury, MD', fake);
  assert.deepStrictEqual(hits, [{ lat: 38.39955, lng: -75.58014, matched: '2203 NORTHWOOD DR, SALISBURY, MD, 21801' }]);
  assert.match(decodeURIComponent(seen.replace(/\+/g, ' ')), /address=2203 Northwood Dr, Salisbury, MD/);
});

test('geocode() returns [] for no match and throws on an HTTP error', async () => {
  const { geocode } = await import('../../scripts/geocode-listing.mjs');
  assert.deepStrictEqual(await geocode('x', async () => ({ ok: true, json: async () => ({ result: { addressMatches: [] } }) })), []);
  await assert.rejects(geocode('x', async () => ({ ok: false, status: 503 })), /HTTP 503/);
});
