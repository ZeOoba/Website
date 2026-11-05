// NEGATIVE: comment-like and import-like text that is NOT a comment or an import of Blobs.
const glob = 'tests/**/*.test.js'; // a "/*" inside a string must not open a block comment
const url = 'https://example.com//path'; // "//" inside a string must not start a line comment
const msg = `uses @netlify/blobs ${glob} via ${url}`;
const re = /['"`]\/\//g; // quotes and slashes inside a regex literal
const ratio = 10 / 2 / 1;
export default async () => new Response(msg.replace(re, '') + ratio);
