// Shared test helpers: sign in as the runner account and find/create the
// one dedicated test company these tests are scoped to. Mirrors the pattern
// in web/tests/enrich-e2e.spec.ts (same createClient + signInWithPassword,
// same find-or-create-by-domain shape).
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENV_PATH = '/Users/carterking/Projects/dad/.env';
process.loadEnvFile(ENV_PATH);

// Test-only default: index.mjs no longer hardcodes PLUGIN_DIR (Task 7 —
// production must ship with no dev-machine paths), so tests that exercise the
// real schema-gated pipeline (lifecycle/timeout/per-user) need it pointed at
// the local plugin checkout. Root .env doesn't carry this (dev config, not a
// secret) — set it here, same "test-only hardcoded dev path" convention as
// ENV_PATH above, only if the environment hasn't already supplied one.
if (!process.env.PLUGIN_DIR) {
  process.env.PLUGIN_DIR = '/Users/carterking/Projects/dad/company-preview/skill/plugins/company-preview';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = path.join(__dirname, '..');
const INDEX = path.join(RUNNER_ROOT, 'index.mjs');

export const COMPANY_NAME = 'Runner Test Co';
export const COMPANY_DOMAIN = 'runner-test.example';

// Real-money guard (20260720120000_pdf_pivot_and_job_leases §F). enrichment_jobs
// .queue_name defaults to 'prod' and index.mjs filters every recovery/poll/claim
// on RUNNER_QUEUE — so a suite that sets NEITHER puts its fixture jobs in the
// production queue, where a developer's live runner claims them and runs REAL
// paid research against the real `claude` binary. Observed 2026-08-12: a live
// paired runner claimed lifecycle fixture jobs mid-suite, which also made the
// fan-out test time out waiting for a job it never got to run.
//
// Unique per process so parallel suite runs can't claim each other's work
// either. Used in BOTH directions: spawnRunner puts it in every spawned
// runner's env, and every fixture job row must carry `queue_name: TEST_QUEUE`.
// Miss it on an insert and that row silently falls back to 'prod' — the guard
// is off for that job only, which is exactly how this went unnoticed.
export const TEST_QUEUE = `test-${process.pid}-${Date.now()}`;

// Shared anon-key client, used by helpers that only need a session/user id
// rather than a per-call client instance (signInRunner below still returns
// its own client for callers that need one).
export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export async function signInRunner() {
  const runner = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data, error } = await runner.auth.signInWithPassword({
    email: process.env.RUNNER_EMAIL,
    password: process.env.RUNNER_PASSWORD,
  });
  if (error) throw error;
  return { runner, userId: data.user.id };
}

export async function findOrCreateCompany(runner, userId, name, domain) {
  const { data: existing, error } = await runner
    .from('companies')
    .select('id')
    .eq('domain', domain)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing.id;

  const { data: created, error: insertError } = await runner
    .from('companies')
    .insert({ name, domain, created_by: userId })
    .select('id')
    .single();
  if (insertError) throw insertError;
  return created.id;
}

export async function findOrCreateRunnerTestCo(runner, userId) {
  const id = await findOrCreateCompany(runner, userId, COMPANY_NAME, COMPANY_DOMAIN);
  // Self-clean: a crashed/killed prior run can strand an active job here, and
  // the one-active-per-company unique index then rejects every new test job.
  // Sweep stale actives before handing the fixture out (same pattern as web's
  // realtime-smoke self-reset).
  await runner
    .from('enrichment_jobs')
    .update({ status: 'failed', error: 'test fixture sweep: stale active job', finished_at: new Date().toISOString() })
    .eq('company_id', id)
    .in('status', ['queued', 'running']);
  return id;
}

// Password sign-in against the fixture account (test-only — production
// index.mjs never reads RUNNER_EMAIL/RUNNER_PASSWORD). Returns the session so
// callers can hand its refresh_token to writeCredsFor.
export async function signInTestUser() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: process.env.RUNNER_EMAIL,
    password: process.env.RUNNER_PASSWORD,
  });
  if (error) throw error;
  return data.session;
}

// Writes a runner credentials file (same shape/mode index.mjs's saveCreds
// produces) so a spawned runner can start from a stored session instead of
// prompting for a pairing code.
export function writeCredsFor(session, credPath) {
  writeFileSync(credPath, JSON.stringify({ refresh_token: session.refresh_token }), { mode: 0o600 });
}

// Service-role client, TEST-ONLY — index.mjs never reads this key. Used to
// create/delete throwaway users for RLS negative tests (a real second
// identity is the only way to prove one user's runner can't touch another's
// jobs) without polluting the shared fixture account. Built lazily (not at
// module load) so test files that never call these two functions can still
// import this module without SUPABASE_SERVICE_ROLE_KEY being set.
let admin;
function adminClient() {
  if (!admin) {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return admin;
}

export async function adminCreateThrowawayUser() {
  const email = `runner-test-${randomUUID().slice(0, 8)}@runner-test.example`;
  const password = randomUUID();
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, email, password };
}

export async function adminDeleteUser(id) {
  await adminClient().auth.admin.deleteUser(id);
}

// Composes writeCredsFor + spawnRunner: writes the given session's refresh
// token to a fresh tmp creds file, then spawns the real runner already
// paired against it (no pairing-code prompt needed).
export function spawnPaired(session, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kr-'));
  const credPath = path.join(dir, 'credentials.json');
  writeCredsFor(session, credPath);
  return spawnRunner({ env: { KR_CREDENTIALS_PATH: credPath, ...extraEnv } });
}

// Spawns the real index.mjs as a child process with env merged over the
// current process's (which already carries the root .env vars loaded above).
// Returns a handle with line/exit waiters instead of the raw ChildProcess,
// since tests need to assert on specific stdout lines and accumulated
// stderr rather than just an exit code (matches the plumbing startup.test.mjs
// and lifecycle.test.mjs each roll locally, generalized here for reuse).
export function spawnRunner(opts = {}) {
  // RUNNER_QUEUE first so an explicit opts.env value still wins (the
  // queue-isolation test needs to spawn a runner on a DIFFERENT queue).
  const env = { ...process.env, RUNNER_QUEUE: TEST_QUEUE, ...opts.env };
  const proc = spawn(process.execPath, [INDEX], { cwd: RUNNER_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuf = '';
  let stderrBuf = '';
  let exited = false;
  let exitCode = null;
  const lineWaiters = new Set();
  const exitWaiters = new Set();

  function checkLineWaiters() {
    if (lineWaiters.size === 0) return;
    const lines = stdoutBuf.split('\n');
    for (const waiter of [...lineWaiters]) {
      const found = lines.find((line) => waiter.regex.test(line));
      if (found !== undefined) {
        lineWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(found);
      }
    }
  }

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    checkLineWaiters();
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
  });
  proc.on('exit', (code) => {
    exited = true;
    exitCode = code;
    for (const waiter of exitWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(code);
    }
    exitWaiters.clear();
  });

  return {
    kill: (signal) => proc.kill(signal),
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    waitForLine(regex, timeoutMs = 10_000) {
      const existing = stdoutBuf.split('\n').find((line) => regex.test(line));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          regex,
          resolve,
          timer: setTimeout(() => {
            lineWaiters.delete(waiter);
            reject(new Error(`timed out waiting for ${regex} (stdout=${stdoutBuf} stderr=${stderrBuf})`));
          }, timeoutMs),
        };
        lineWaiters.add(waiter);
      });
    },
    waitForExit(timeoutMs = 10_000) {
      if (exited) return Promise.resolve(exitCode);
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            exitWaiters.delete(waiter);
            proc.kill('SIGKILL');
            reject(new Error(`child did not exit within ${timeoutMs}ms (stdout=${stdoutBuf} stderr=${stderrBuf})`));
          }, timeoutMs),
        };
        exitWaiters.add(waiter);
      });
    },
  };
}
