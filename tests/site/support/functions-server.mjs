/**
 * functions-server.mjs — starts `netlify functions:serve` for tests/site/functions-smoke.test.mjs and does not
 * return until the server answering on the chosen port is PROVABLY that CLI serving the chat-lead function.
 *
 * WHY THIS IS NOT JUST "spawn and poll" (main CI run 38802432794, 2026-10-15): the old harness picked a port by
 * listening on :0 and closing, spawned the CLI on it, and treated ANY non-404 answer as ready. On the shared
 * self-hosted laptop another process took the port in between, answered 403 to everything, and counted as
 * "ready" within 3 s, so all 8 assertions failed although the code under test was fine. This module closes
 * both holes:
 *   1. Readiness requires the real function's signature (204 + `Access-Control-Allow-Methods: POST, OPTIONS`
 *      on an OPTIONS preflight), not "anything but 404".
 *   2. A foreign answer that persists, or a CLI that exits before it is ready (EADDRINUSE), is a port
 *      collision: kill the CLI, pick a fresh port and try again (bounded), then fail with a message that names
 *      every port tried and what answered.
 * A slow start is NOT a collision: a timeout is terminal and carries the CLI output, because retrying would
 * only double a wait that is already the problem. Everything environmental is injectable so
 * tests/scripts/functions-server.test.js can pin this with fakes (no CLI, no network).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

export const FUNCTION = 'chat-lead';
export const SIGNATURE_METHODS = 'POST, OPTIONS';

/** 'ready' | 'loading' | 'error' | 'foreign' for the answer to an OPTIONS preflight of the chat-lead function. */
export function classifyProbe(res) {
  if (res.status === 404) return 'loading'; // functions finish loading after the CLI is listening
  if (res.status === 204 && res.headers.get('access-control-allow-methods') === SIGNATURE_METHODS) return 'ready';
  if (res.status >= 500) return 'error'; // the function (or its bundle) is not healthy yet
  return 'foreign'; // answered, but not as our function would: someone else owns this port
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Real CLI launcher: returns the child and a getter for everything it printed. */
export function spawnFunctionsCli({ cli, cwd, env = process.env }) {
  return (port, base) => {
    const child = spawn(
      process.execPath,
      [cli, 'functions:serve', '--offline', '--port', String(port), '-f', 'netlify/functions'],
      {
        cwd,
        env: {
          ...env,
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
    return { child, getLog: () => log };
  };
}

/** Real probe: an OPTIONS preflight of the function, never allowed to hang. */
export const probeFunction = (base, name = FUNCTION) =>
  fetch(`${base}/.netlify/functions/${name}`, { method: 'OPTIONS', signal: AbortSignal.timeout(5000) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 1500) => (s.length > n ? `...${s.slice(-n)}` : s);

export async function startFunctionsServer({
  spawnServer,
  pickPort = freePort,
  probe = probeFunction,
  attempts = 3,
  readyTimeoutMs = 180_000,
  pollMs = 1000,
  foreignThreshold = 5, // consecutive foreign answers before we call it a collision (~5 s at the default poll)
}) {
  const deadline = Date.now() + readyTimeoutMs;
  const tried = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await pickPort();
    const base = `http://127.0.0.1:${port}`;
    const { child, getLog } = spawnServer(port, base);
    let exited = false;
    child.once('exit', () => { exited = true; });

    let foreign = 0;
    let lastForeign = '';
    let lastError = '';
    let outcome = null;

    while (!outcome) {
      if (exited) { outcome = 'exited'; break; }
      if (Date.now() > deadline) { outcome = 'timeout'; break; }
      try {
        const res = await probe(base);
        const kind = classifyProbe(res);
        if (kind === 'ready') {
          if (exited) { outcome = 'exited'; break; } // answered, then died: not ours to trust
          return { base, port, child, getLog, attempts: attempt };
        }
        if (kind === 'foreign') {
          foreign += 1;
          lastForeign = `HTTP ${res.status}`;
          if (foreign >= foreignThreshold) { outcome = 'foreign'; break; }
        } else {
          foreign = 0;
          if (kind === 'error') lastError = `HTTP ${res.status}`;
        }
      } catch {
        foreign = 0; // not listening yet
      }
      await sleep(pollMs);
    }

    try { child.kill(); } catch { /* already gone */ }

    if (outcome === 'timeout') {
      throw new Error(
        `netlify functions:serve never served ${FUNCTION} on port ${port} within ${readyTimeoutMs} ms` +
        `${lastError ? ` (last error answer: ${lastError})` : ''}. CLI output:\n${tail(getLog())}`
      );
    }
    tried.push({
      port,
      reason: outcome === 'foreign'
        ? `foreign responder on the port (${lastForeign} x${foreignThreshold}, not the ${FUNCTION} function)`
        : `the CLI exited before it was ready. CLI output:\n${tail(getLog(), 600)}`,
    });
  }

  throw new Error(
    `could not start netlify functions:serve after ${attempts} attempts (port collisions on a shared machine):\n` +
    tried.map((t) => `  - port ${t.port}: ${t.reason}`).join('\n')
  );
}
