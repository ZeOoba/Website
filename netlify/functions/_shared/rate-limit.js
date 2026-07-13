'use strict';

// Netlify Blobs never injects credentials for the classic (CommonJS
// exports.handler) function runtime this codebase uses — confirmed via a
// production diagnostic (see PR #25, 2026-07-12): NETLIFY_BLOBS_CONTEXT is
// absent and the invocation context is a plain AWS-Lambda-compatible shape,
// not Netlify's Node.js-runtime Context. Using the Neon Postgres database
// already provisioned for this site (NETLIFY_DATABASE_URL) instead.

// Persists across warm invocations of the same container, resetting only on
// cold start — avoids re-running CREATE TABLE on every single request.
let schemaEnsured = false;

async function defaultGetClient() {
  const { Client } = require('pg');
  const connectionString = process.env.NETLIFY_DATABASE_URL;
  if (!connectionString) throw new Error('rate-limit: missing NETLIFY_DATABASE_URL');
  const client = new Client({ connectionString });
  await client.connect();
  return {
    query: async (text, params) => (await client.query(text, params)).rows,
    end: () => client.end(),
  };
}

async function checkRateLimit(key, { getClient = defaultGetClient, limit = 20, windowMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const client = await getClient();
  try {
    if (!schemaEnsured) {
      await client.query('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start BIGINT NOT NULL, count INTEGER NOT NULL)', []);
      schemaEnsured = true;
    }

    const rlKey = `rl:${key}`;
    const rows = await client.query('SELECT window_start, count FROM rate_limits WHERE key = $1', [rlKey]);
    const current = rows[0] ? { windowStart: Number(rows[0].window_start), count: Number(rows[0].count) } : null;
    const nowMs = now();

    if (!current || current.windowStart + windowMs <= nowMs) {
      await client.query('INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1) ON CONFLICT (key) DO UPDATE SET window_start = $2, count = 1', [rlKey, nowMs]);
      return true;
    }
    if (current.count >= limit) return false;
    await client.query('UPDATE rate_limits SET count = count + 1 WHERE key = $1', [rlKey]);
    return true;
  } finally {
    await client.end();
  }
}

module.exports = { checkRateLimit };
