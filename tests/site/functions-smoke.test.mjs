/**
 * functions-smoke.test.mjs — exercises a Netlify Function through NETLIFY'S OWN
 * RUNTIME, over HTTP, instead of `require()`-ing the module.
 *
 * THE REGRESSION CLASS THIS EXISTS FOR: the tests in tests/functions/** load a
 * handler with `require()` and call it as a plain JS function. That can never
 * observe anything about the *runtime shape* Netlify expects — which handler
 * signature is in force, whether the module is loaded as CommonJS or as a V2
 * ES-module function, or whether Netlify's bundler can even load the file. That
 * distinction is precisely what broke the broker pipeline in production while
 * "every local test passed": the module was fine, its runtime contract was not.
 * A request that goes in over HTTP and comes back through Netlify's own loader
 * cannot be fooled that way.
 *
 * SCOPE: chat-lead only, deliberately. It is a non-broker function (the broker
 * functions are owned by fix/broker-extraction-esm-bundling) and it needs no
 * secrets on any path asserted here. This file is written as a TEMPLATE — the
 * server harness and `invokeFunction()` are generic, so covering
 * owner-lead-notify or tenant-application-processor later means adding cases,
 * not rewriting plumbing.
 *
 * OPERATIONAL NOTES (both learned the hard way, do not "simplify" them away):
 *  - `-f netlify/functions` is REQUIRED. Without it `functions:serve` does not
 *    discover the functions directory and every route 404s, which reads exactly
 *    like a broken function.
 *  - Functions finish loading AFTER the CLI prints "Local dev server ready", so
 *    readiness must poll a real function route, not just the port.
 *
 * Run: npm run test:functions
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'node_modules', 'netlify-cli', 'bin', 'run.js');
const FUNCTION = 'chat-lead';
const READY_TIMEOUT_MS = 180_000;

let child;
let base;

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** POST/GET/OPTIONS a deployed-style function path. Generic on purpose. */
async function invokeFunction(name, init = {}) {
  return fetch(`${base}/.netlify/functions/${name}`, init);
}

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [CLI, 'functions:serve', '--offline', '--port', String(port), '-f', 'netlify/functions'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        // Pin the function's own Netlify-Forms POST target at the local server
        // so it loops back to localhost and never reaches oxfordra.net.
        URL: base,
        NETLIFY_TELEMETRY_DISABLED: '1',
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`netlify functions:serve never served ${FUNCTION}. CLI output:\n${log}`);
    }
    try {
      const r = await invokeFunction(FUNCTION, { method: 'OPTIONS' });
      if (r.status !== 404) break;
    } catch {
      /* server not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}, { timeout: READY_TIMEOUT_MS + 20_000 });

after(() => {
  if (child && !child.killed) child.kill();
});

test('CORS preflight returns 204 through the Netlify runtime', async () => {
  const r = await invokeFunction(FUNCTION, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('GET is rejected with 405', async () => {
  const r = await invokeFunction(FUNCTION, { method: 'GET' });
  assert.equal(r.status, 405);
});

test('malformed JSON body is rejected with 400 invalid_json', async () => {
  const r = await invokeFunction(FUNCTION, jsonPost('{not json'));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'invalid_json' });
});

test('missing name is rejected with 400 invalid_name', async () => {
  const r = await invokeFunction(
    FUNCTION,
    jsonPost({ email: 'a@b.co', role: 'Broker', message: 'ten chars minimum here' })
  );
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'invalid_name' });
});

test('unknown role is rejected with 400 invalid_role', async () => {
  const r = await invokeFunction(
    FUNCTION,
    jsonPost({ name: 'Test Broker', email: 'a@b.co', role: 'Astronaut', message: 'ten chars minimum here' })
  );
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'invalid_role' });
});

test('a well-formed lead is accepted with 200 {ok:true}', async () => {
  const r = await invokeFunction(
    FUNCTION,
    jsonPost({
      name: 'Test Broker',
      email: 'broker@example.com',
      role: 'Broker',
      message: 'CI smoke test submission, at least ten characters long.',
      sessionId: 'ci-smoke',
      transcript: [{ role: 'user', content: 'hello' }],
    })
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('a filled honeypot is silently accepted (200) and never errors', async () => {
  const r = await invokeFunction(FUNCTION, jsonPost({ website: 'http://spam.example' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});
