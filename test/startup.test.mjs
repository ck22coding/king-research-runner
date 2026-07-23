// Startup tests: env loading, CLAUDE_BIN resolution, Supabase sign-in must
// all fail loudly (nonzero exit + clear stderr) when misconfigured. Both
// tests spawn the real index.mjs against the real root .env (never a copy)
// and only perturb one thing each: PATH (for claude resolution) or the
// public anon key (safe to override — it's a public key, not a secret).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
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

// A stand-in Supabase that signs the runner in, lets boot crash-recovery
// through (a PATCH), then denies every poll (a GET) with the exact PostgREST
// error a dead auth session produces: the client silently drops to the `anon`
// role, which has no grant on enrichment_jobs, so Postgres raises 42501
// instead of returning zero rows.
//
// A stub is the only way to reach this state. Against the real Supabase an
// issued JWT keeps verifying until it expires — even deleting the user leaves
// polls succeeding-but-empty, which is the opposite of the bug.
function startDeniedPollSupabase() {
  const userId = randomUUID();
  const email = 'dead-session@runner-test.example';
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} };
  const session = {
    // Shaped like a real JWT (supabase-js reads the payload), never verified —
    // this server rejects the only calls that would carry it anyway.
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, email, role: 'authenticated', aud: 'authenticated', exp })}.stub`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    refresh_token: 'stub-refresh-token',
    user,
  };

  let polls = 0;
  const server = createServer((req, res) => {
    req.resume();
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith('/auth/v1/token') || req.url.startsWith('/auth/v1/user')) {
      return json(200, req.url.startsWith('/auth/v1/user') ? user : session);
    }
    if (req.method === 'GET' && req.url.startsWith('/rest/v1/enrichment_jobs')) {
      polls += 1;
      return json(403, { code: '42501', message: 'permission denied for table enrichment_jobs', details: null, hint: null });
    }
    // Crash-recovery's PATCH and the heartbeat upsert must succeed: recovery
    // failing exits FATAL at boot, which is a different code path than the one
    // under test.
    return json(200, []);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        polls: () => polls,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
      });
    });
  });
}

test('poll denied forever (dead auth session): gives up and exits nonzero', async () => {
  const stub = await startDeniedPollSupabase();
  const credPath = path.join(mkdtempSync(path.join(tmpdir(), 'kr-dead-')), 'credentials.json');
  writeFileSync(credPath, JSON.stringify({ refresh_token: 'stub-refresh-token' }), { mode: 0o600 });

  try {
    // The bug: the poll loop logged 'will retry' and slept forever, so the
    // runner looked alive while doing nothing and jobs sat Queued with no
    // failure surfaced. runChild rejects if the child never exits — that
    // rejection IS the regression.
    const { code, stderr } = await runChild(
      {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: stub.url,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon-key',
        KR_CREDENTIALS_PATH: credPath,
        RUNNER_QUEUE: `test-deadsession-${process.pid}`,
        RUNNER_CONCURRENCY: '1',
        POLL_INTERVAL_MS: '50',
      },
      20_000
    );
    assert.equal(code, 1, `expected exit 1, got ${code} (stderr=${stderr})`);
    assert.match(stderr, /consecutive poll errors/);
    assert.match(stderr, /permission denied for table enrichment_jobs/);
    // Pins the cap itself: 19 retries, then the 20th failure halts. One worker
    // and a 50ms poll keep that under two seconds.
    assert.equal(stub.polls(), 20, 'must give up after MAX_CONSECUTIVE_POLL_ERRORS polls');
  } finally {
    await stub.close();
  }
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
