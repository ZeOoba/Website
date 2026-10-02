/**
 * geocode-listing.mjs — look up lat/lng for a new data/listings.json entry.
 *
 *   node scripts/geocode-listing.mjs "2203 Northwood Dr, Salisbury, MD"
 *
 * Uses the US Census geocoder (a primary source, no key). It INTERPOLATES along the
 * street centerline, so the result lands on the right block but often not on the
 * building (and for a street with two disconnected segments can pick the wrong one:
 * 2000-2026 Zettler Rd came back 100+ m away, in a townhome area). Treat the output
 * as a starting point, then confirm against the county parcel layer or aerial imagery
 * and put the pin on the building. build-listings.mjs rejects coordinates with fewer
 * than 4 decimals or outside the listing's state.
 */

import url from 'node:url';

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

export async function geocode(address, fetchImpl = fetch) {
  const qs = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
  const res = await fetchImpl(`${ENDPOINT}?${qs}`);
  if (!res.ok) throw new Error(`Census geocoder HTTP ${res.status}`);
  const matches = (await res.json()).result.addressMatches;
  return matches.map((m) => ({ lat: +m.coordinates.y.toFixed(5), lng: +m.coordinates.x.toFixed(5), matched: m.matchedAddress }));
}

if (process.argv[1] && url.fileURLToPath(import.meta.url) === process.argv[1]) {
  const address = process.argv.slice(2).join(' ').trim();
  if (!address) { console.error('usage: node scripts/geocode-listing.mjs "<street>, <city>, <ST>"'); process.exit(1); }
  const hits = await geocode(address);
  if (!hits.length) { console.error('no match - try the street number of one unit in the range, or use the county parcel layer'); process.exit(2); }
  for (const h of hits) console.log(`"lat": ${h.lat},\n"lng": ${h.lng},   // ${h.matched}`);
  console.error('Interpolated along the street: confirm on the building (county parcel / aerial) before committing.');
}
