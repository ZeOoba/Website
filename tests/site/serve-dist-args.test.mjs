// Regression test for `npm run serve` crashing with
// "options.port should be >= 0 and < 65536. Received type number (NaN)".
// package.json and serve-dist.mjs's own doc comment both pass `--port 8788`
// (space-separated), but the CLI parser only understood `--key=value`, so it
// produced {port: 'true', '8788': 'true'} and parseInt('true') -> NaN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../../scripts/serve-dist.mjs';

test('space-separated form: --port 8788 --root dist', () => {
  assert.deepEqual(parseCliArgs(['--port', '8788', '--root', 'dist']), { port: 8788, root: 'dist' });
});

test('equals form: --port=8788 --root=dist', () => {
  assert.deepEqual(parseCliArgs(['--port=8788', '--root=dist']), { port: 8788, root: 'dist' });
});

test('mixed forms parse identically', () => {
  assert.deepEqual(parseCliArgs(['--port=8788', '--root', 'dist']), { port: 8788, root: 'dist' });
});

test('the exact package.json "serve" invocation yields a valid port', () => {
  assert.deepEqual(parseCliArgs(['--port', '8788']), { port: 8788 });
});

test('no args defaults to port 8788 and leaves root unset', () => {
  assert.deepEqual(parseCliArgs([]), { port: 8788 });
});

test('a non-numeric or out-of-range port fails loudly instead of becoming NaN', () => {
  assert.throws(() => parseCliArgs(['--port', 'abc']), /invalid --port/);
  assert.throws(() => parseCliArgs(['--port', '70000']), /invalid --port/);
});

test('unknown flags are rejected rather than silently ignored', () => {
  assert.throws(() => parseCliArgs(['--prot', '8788']));
});
