// Startup tests: env loading, CLAUDE_BIN resolution, Supabase sign-in must
// all fail loudly (nonzero exit + clear stderr) when misconfigured. Both
// tests spawn the real index.mjs against the real root .env (never a copy)
// and only perturb one thing each: PATH (for claude resolution) or the
// public anon key (safe to override — it's a public key, not a secret).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { signInTestUser, spawnPaired } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, '..', 'index.mjs');

// Runs index.mjs with the given env, waits for exit, and kills+fails if it
// runs past safetyMs (the placeholder poll loop must never be reached here).
function runChild(env, safetyMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not exit within ${safetyMs}ms (stdout=${stdout} stderr=${stderr})`));
    }, safetyMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('no CLAUDE_BIN + stripped PATH: exits nonzero, stderr explains claude resolution', async () => {
  const env = { ...process.env, PATH: '/usr/bin:/bin' };
  delete env.CLAUDE_BIN;
  const { code, stderr } = await runChild(env, 5000);
  assert.notEqual(code, 0);
  assert.match(stderr.toLowerCase(), /resolv.*claude|claude.*resolv/);
});

test('bogus NEXT_PUBLIC_SUPABASE_ANON_KEY: exits nonzero, stderr explains pairing/login failure', async () => {
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'bogus' };
  const { code, stderr } = await runChild(env, 15000);
  assert.notEqual(code, 0);
  assert.match(stderr.toLowerCase(), /no valid login.*re-pair this computer/s);
});

test('PLUGIN_DIR unset: reaches the poll loop instead of exiting fatally (marketplace-install case)', async () => {
  const session = await signInTestUser();
  // Own queue name so this never touches a real 'prod' job; PLUGIN_DIR: ''
  // overrides helpers.mjs's test-only default (falsy, same as truly unset).
  const child = await spawnPaired(session, { PLUGIN_DIR: '', RUNNER_QUEUE: `test-nodir-${process.pid}` });
  try {
    await child.waitForLine(/runner started/, 15_000);
    // The bug this regresses: PLUGIN_DIR unset made SCHEMA_PATH null, and
    // reading the schema right after this log line threw + exit(1). Give it
    // a moment past that point and confirm the process is still alive.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.doesNotThrow(() => child.kill(0), 'runner must still be running, not fatally exited');
    assert.equal(child.stderr(), '');
  } finally {
    child.kill();
  }
});
