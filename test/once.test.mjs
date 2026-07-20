// Once-mode tests: drive the real index.mjs with RUNNER_ONCE=1 against the
// live Supabase project as the runner user, pointed at fake CLAUDE_BIN
// fixtures so no real claude -p run happens. Covers the two on-demand
// guarantees: (1) an empty queue exits promptly instead of polling forever,
// (2) a queued job is drained to a terminal status before the process exits
// — never abandoned mid-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { signInRunner, findOrCreateRunnerTestCo } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = path.join(__dirname, '..');
const INDEX = path.join(RUNNER_ROOT, 'index.mjs');
const FIXTURE_SUCCESS_SLOW = path.join(__dirname, 'fixtures', 'fake-claude-success-slow.mjs');

const POLL_INTERVAL_MS = 500;
const EXIT_TIMEOUT_MS = 15000;

function spawnOnceRunner(claudeBin) {
  const env = {
    ...process.env,
    CLAUDE_BIN: claudeBin,
    POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
    RUNNER_ONCE: '1',
    RUNNER_CONCURRENCY: '1',
  };
  const child = spawn(process.execPath, [INDEX], { cwd: RUNNER_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  return { child, getStdout: () => stdout };
}

// Resolves with the child's exit code, or rejects if it hasn't exited within
// EXIT_TIMEOUT_MS — a once-mode process that never exits is the failure mode
// this whole suite exists to catch.
function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`once-mode process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function cleanup(runner, companyId, jobId) {
  await runner.from('facts').update({ status: 'rejected' }).eq('company_id', companyId);
  if (jobId) {
    await runner
      .from('enrichment_jobs')
      .update({ status: 'failed', error: 'test cleanup: once-mode harness run', finished_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', ['queued', 'running']);
  }
}

test('once-mode: an empty queue exits promptly with code 0', async (t) => {
  const { child } = spawnOnceRunner(FIXTURE_SUCCESS_SLOW);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const start = Date.now();
  const code = await waitForExit(child, EXIT_TIMEOUT_MS);
  const elapsedMs = Date.now() - start;

  assert.equal(code, 0, 'expected exit code 0 when the queue is empty');
  // Well under one poll interval's worth of sleeping-and-retrying — proves
  // the worker returned on the first empty poll rather than looping.
  assert.ok(elapsedMs < POLL_INTERVAL_MS * 3, `expected a fast exit, took ${elapsedMs}ms`);
});

test('once-mode: a queued job is drained (finishes) before the process exits', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const { child } = spawnOnceRunner(FIXTURE_SUCCESS_SLOW);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await cleanup(runner, companyId, job.id);
  });

  // Fixture sleeps 2s before emitting — confirm the job is still non-terminal
  // (claimed, in flight) partway through, before asserting on the exit.
  await sleep(800);
  const { data: midRun, error: midRunError } = await runner
    .from('enrichment_jobs')
    .select('status')
    .eq('id', job.id)
    .single();
  if (midRunError) throw midRunError;
  assert.equal(midRun.status, 'running', 'expected the job still in flight partway through the fixture delay');

  const code = await waitForExit(child, EXIT_TIMEOUT_MS);
  assert.equal(code, 0, 'expected exit code 0 after the in-flight job completed');

  const { data: finalJob, error: finalJobError } = await runner
    .from('enrichment_jobs')
    .select('status, error')
    .eq('id', job.id)
    .single();
  if (finalJobError) throw finalJobError;
  assert.equal(
    finalJob.status,
    'done',
    `expected the job drained to 'done' before exit, got '${finalJob.status}' (error=${finalJob.error})`
  );
});
