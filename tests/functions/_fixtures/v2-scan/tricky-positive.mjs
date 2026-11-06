// POSITIVE: the real import follows constructs that a naive comment stripper would mangle.
const glob = 'tests/**/*.js';
const re = /['"`]/g;
const url = 'https://example.com//x'; /* closed */ import { getStore } from '@netlify/blobs';
export default async () => new Response(String(typeof getStore) + glob + url + re.source);
