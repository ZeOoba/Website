'use strict';
/**
 * functions-server.test.js — unit tests for the start-up logic that tests/site/functions-smoke.test.mjs
 * uses to launch `netlify functions:serve` (tests/site/support/functions-server.mjs).
 *
 * WHY: on 2026-10-15 the smoke test failed 8/8 on main with every request answering 403 within 3 s,
 * although the identical code had just passed. The harness picked a "free" port by listening and closing
 * it, then started the CLI on it; on the shared self-hosted laptop another process took the port, and the
 * readiness loop accepted ANY non-404 answer, so a stray listener counted as "ready". These tests pin the
 * hardened behaviour with fakes (no CLI, no network): only the real chat-lead signature counts as ready,
 * and a foreign responder or an early CLI exit is retried on a fresh port with a clear final error.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

let modPromise;
const load = () => (modPromise ||= import(pathToFileURL(path.join(__dirname, '..', 'site', 'support', 'functions-server.mjs')).href));

const READY = () => new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'POST, OPTIONS' } });
const status = (s, headers) => () => new Response(null, { status: s, headers });

/** A scripted fake of the whole world: one entry per attempt (port), each a list of probe behaviours. */
function world(attempts) {
  const ports = attempts.map((_, i) => 40000 + i);
  const spawned = [];
  const probed = [];
  let portIdx = 0;
  const cursor = new Map();
  return {
    spawned,
    probed,
    opts: {
      pickPort: async () => ports[Math.min(portIdx++, ports.length - 1)],
      spawnServer: (port) => {
        const child = new EventEmitter();
        child.killed = false;
        child.exitCode = null;
        child.kill = () => { child.killed = true; };
        spawned.push({ port, child });
        const spec = attempts[ports.indexOf(port)];
        if (spec.exits) setImmediate(() => { child.exitCode = 1; child.emit('exit', 1); });
        return { child, getLog: () => spec.log || '' };
      },
      probe: async (base) => {
        const port = Number(base.split(':').pop());
        probed.push(port);
        const spec = attempts[ports.indexOf(port)];
        const i = cursor.get(port) || 0;
        cursor.set(port, i + 1);
        const step = spec.steps[Math.min(i, spec.steps.length - 1)];
        if (step === 'refused') throw new Error('ECONNREFUSED');
        return step();
      },
      pollMs: 1,
      readyTimeoutMs: 2000,
      foreignThreshold: 3,
      attempts: 3,
    },
  };
}

test('classifyProbe: only 204 + the chat-lead CORS signature is ready; 404 is loading; 5xx is an error; anything else is foreign', async () => {
  const { classifyProbe } = await load();
  assert.equal(classifyProbe(READY()), 'ready');
  assert.equal(classifyProbe(new Response(null, { status: 404 })), 'loading');
  assert.equal(classifyProbe(new Response(null, { status: 500 })), 'error');
  assert.equal(classifyProbe(new Response(null, { status: 503 })), 'error');
  assert.equal(classifyProbe(new Response(null, { status: 403 })), 'foreign');
  assert.equal(classifyProbe(new Response(null, { status: 200 })), 'foreign');
  assert.equal(classifyProbe(new Response(null, { status: 204 })), 'foreign', '204 without the signature header is not our function');
  assert.equal(classifyProbe(new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET' } })), 'foreign');
});

test('starts normally: connection refused and 404 while loading, then the signature, with no retry', async () => {
  const { startFunctionsServer } = await load();
  const w = world([{ steps: ['refused', status(404), status(404), READY] }]);
  const server = await startFunctionsServer(w.opts);
  assert.equal(server.port, 40000);
  assert.equal(server.base, 'http://127.0.0.1:40000');
  assert.equal(w.spawned.length, 1, 'a healthy start must not spawn a second CLI');
});

test('a foreign 403 responder on the port is NOT mistaken for readiness: retry on a fresh port (the 2026-10-15 failure)', async () => {
  const { startFunctionsServer } = await load();
  const w = world([
    { steps: [status(403)] },                 // stray listener answers 403 to everything, forever
    { steps: [status(404), READY] },          // fresh port: the real CLI
  ]);
  const server = await startFunctionsServer(w.opts);
  assert.equal(server.port, 40001, 'must end up on the second port');
  assert.equal(w.spawned.length, 2);
  assert.equal(w.spawned[0].child.killed, true, 'the CLI that lost the port race must be killed');
  assert.equal(w.spawned[1].child.killed, false);
});

test('a CLI that exits before it is ready (e.g. EADDRINUSE) is retried on a fresh port', async () => {
  const { startFunctionsServer } = await load();
  const w = world([
    { steps: ['refused'], exits: true, log: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:40000' },
    { steps: [READY] },
  ]);
  const server = await startFunctionsServer(w.opts);
  assert.equal(server.port, 40001);
  assert.equal(w.spawned.length, 2);
});

test('a transient 5xx while functions load does not count as a collision', async () => {
  const { startFunctionsServer } = await load();
  const w = world([{ steps: [status(500), status(500), status(500), status(500), status(500), READY] }]);
  const server = await startFunctionsServer(w.opts);
  assert.equal(server.port, 40000);
  assert.equal(w.spawned.length, 1, 'loading errors must be waited out, not retried on another port');
});

test('a foreign answer that stops (below the threshold) does not trigger a retry', async () => {
  const { startFunctionsServer } = await load();
  const w = world([{ steps: [status(403), status(403), status(404), READY] }]); // 2 foreign < threshold 3, then loading, then ready
  const server = await startFunctionsServer(w.opts);
  assert.equal(server.port, 40000);
  assert.equal(w.spawned.length, 1);
});

test('every attempt hitting a foreign responder fails with a clear message naming each port and the status', async () => {
  const { startFunctionsServer } = await load();
  const w = world([{ steps: [status(403)] }, { steps: [status(403)] }, { steps: [status(403)] }]);
  await assert.rejects(() => startFunctionsServer(w.opts), (err) => {
    assert.match(err.message, /3 attempts/);
    assert.match(err.message, /40000/);
    assert.match(err.message, /40001/);
    assert.match(err.message, /40002/);
    assert.match(err.message, /foreign responder/i);
    assert.match(err.message, /403/);
    return true;
  });
  assert.ok(w.spawned.every((s) => s.child.killed), 'no CLI may be left running after giving up');
});

test('a slow start that never serves times out WITHOUT retrying, and the error carries the CLI output', async () => {
  const { startFunctionsServer } = await load();
  const w = world([{ steps: [status(404)], log: 'CLI says: bundling netlify/functions ...' }, { steps: [READY] }]);
  w.opts.readyTimeoutMs = 60;
  await assert.rejects(() => startFunctionsServer(w.opts), (err) => {
    assert.match(err.message, /never served/i);
    assert.match(err.message, /bundling netlify\/functions/);
    return true;
  });
  assert.equal(w.spawned.length, 1, 'a timeout is not a collision: retrying would double the wait');
  assert.equal(w.spawned[0].child.killed, true);
});

test('each attempt picks a fresh port and passes it to the CLI and to the probe', async () => {
  const { startFunctionsServer } = await load();
  const w = world([{ steps: [status(403)] }, { steps: [READY] }]);
  await startFunctionsServer(w.opts);
  assert.deepEqual(w.spawned.map((s) => s.port), [40000, 40001]);
  assert.ok(w.probed.includes(40000) && w.probed.includes(40001));
});
