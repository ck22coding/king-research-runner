// Shared test helpers: sign in as the runner account and find/create the
// one dedicated test company these tests are scoped to. Mirrors the pattern
// in web/tests/enrich-e2e.spec.ts (same createClient + signInWithPassword,
// same find-or-create-by-domain shape).
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ENV_PATH = '/Users/carterking/Projects/dad/.env';
process.loadEnvFile(ENV_PATH);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = path.join(__dirname, '..');
const INDEX = path.join(RUNNER_ROOT, 'index.mjs');

export const COMPANY_NAME = 'Runner Test Co';
export const COMPANY_DOMAIN = 'runner-test.example';

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

export function findOrCreateRunnerTestCo(runner, userId) {
  return findOrCreateCompany(runner, userId, COMPANY_NAME, COMPANY_DOMAIN);
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
export function writeCredsFor(session, path) {
  writeFileSync(path, JSON.stringify({ refresh_token: session.refresh_token }), { mode: 0o600 });
}

// Spawns the real index.mjs as a child process with env merged over the
// current process's (which already carries the root .env vars loaded above).
// Returns a handle with line/exit waiters instead of the raw ChildProcess,
// since tests need to assert on specific stdout lines and accumulated
// stderr rather than just an exit code (matches the plumbing startup.test.mjs
// and lifecycle.test.mjs each roll locally, generalized here for reuse).
export function spawnRunner(opts = {}) {
  const env = { ...process.env, ...opts.env };
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
