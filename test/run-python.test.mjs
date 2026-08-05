// Pure unit test for lib/run-python.mjs: drives process.execPath + small Node
// fixture scripts as the stand-in child, so this exercises the wrapper's
// argv/cwd/timeout/kill/output-cap mechanics without needing python3 or the
// real deck-build scripts installed anywhere (dev machine or CI). No
// Supabase, no sign-in, no network — runs in well under a second except the
// one timeout case, which waits out the real kill-grace window on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { runPython } from '../lib/run-python.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_OK = path.join(__dirname, 'fixtures', 'fake-python-ok.mjs');
const FIXTURE_FAIL = path.join(__dirname, 'fixtures', 'fake-python-fail.mjs');
const FIXTURE_HANG = path.join(__dirname, 'fixtures', 'fake-python-hang.mjs');

test('runPython: normal exit 0 forwards argv + cwd and captures stdout/stderr', async () => {
  const cwd = os.tmpdir();
  const result = await runPython({
    bin: process.execPath,
    args: [FIXTURE_OK, '--spec', 'out.json'],
    cwd,
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.spawnError, null);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /fake-python-ok: a stderr line/);

  const parsed = JSON.parse(result.stdout);
  // The fixture's own argv.slice(2) already drops [execPath, scriptPath].
  assert.deepEqual(parsed.argv, ['--spec', 'out.json']);
  // realpath both sides — tmpdir can be a symlink (e.g. macOS /var -> /private/var).
  assert.equal(realpathSync(parsed.cwd), realpathSync(cwd));
});

test('runPython: non-zero exit is reported, not thrown', async () => {
  const result = await runPython({
    bin: process.execPath,
    args: [FIXTURE_FAIL],
    timeoutMs: 5000,
  });

  assert.equal(result.code, 3);
  assert.equal(result.spawnError, null);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /deliberate failure/);
});

test('runPython: a hung child is SIGTERM-ed then SIGKILL-ed, timedOut true', async () => {
  const timeoutMs = 150;
  const start = Date.now();
  const result = await runPython({
    bin: process.execPath,
    args: [FIXTURE_HANG],
    timeoutMs,
  });
  const elapsed = Date.now() - start;

  assert.equal(result.timedOut, true);
  // The fixture ignores SIGTERM, so the only way it ever exits is the
  // wrapper's SIGKILL fallback after the fixed grace period — elapsed time
  // must clear timeoutMs + that grace window, not just timeoutMs alone.
  assert.ok(elapsed >= timeoutMs + 4500, `expected the grace period to elapse before kill, took ${elapsed}ms`);
  assert.ok(elapsed < 20_000, `expected SIGKILL to actually land, took ${elapsed}ms`);
  assert.equal(result.code, null);
}, { timeout: 20_000 });

test('runPython: a bad bin path resolves with spawnError, never rejects', async () => {
  const result = await runPython({
    bin: path.join(__dirname, 'fixtures', 'no-such-binary-here'),
    args: [],
    timeoutMs: 5000,
  });

  assert.ok(result.spawnError, 'expected spawnError to be set');
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);
});
