// Timeout test: drives the real index.mjs against the live Supabase project
// as the runner user, pointed at a fake CLAUDE_BIN that hangs forever and a
// short CLAUDE_TIMEOUT_MS. Proves the hard-timeout kill path lands the job in
// 'failed' (never stuck 'running') with a timeout-mentioning error, and
// restores company status — routed through the exact same failure handling
// as any other claude failure (see index.mjs's runClaude/checkShape).
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
const FIXTURE_HANG = path.join(__dirname, 'fixtures', 'fake-claude-hang.mjs');

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10000;
const CLAUDE_TIMEOUT_MS = 2000;

function spawnRunner(claudeBin) {
  const env = {
    ...process.env,
    CLAUDE_BIN: claudeBin,
    POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
    CLAUDE_TIMEOUT_MS: String(CLAUDE_TIMEOUT_MS),
  };
  return spawn(process.execPath, [INDEX], { cwd: RUNNER_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function killChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// Same shape as lifecycle.test.mjs's poller: returns whatever the row looks
// like at the deadline rather than throwing, so a miss surfaces as a clean
// assertion failure in the caller.
async function pollUntilTerminal(runner, jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let job;
  do {
    const { data, error } = await runner.from('enrichment_jobs').select('*').eq('id', jobId).single();
    if (error) throw error;
    job = data;
    if (job.status === 'done' || job.status === 'failed') return job;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return job;
}

// ponytail: same blanket-reject-facts + park-non-terminal-job cleanup as
// lifecycle.test.mjs — Runner Test Co exists solely for these tests.
async function cleanup(runner, companyId, jobId) {
  await runner.from('facts').update({ status: 'rejected' }).eq('company_id', companyId);
  await runner
    .from('enrichment_jobs')
    .update({ status: 'failed', error: 'test cleanup: timeout harness run', finished_at: new Date().toISOString() })
    .eq('id', jobId)
    .in('status', ['queued', 'running']);
}

test('timeout: a hung claude run is killed and the job fails with a timeout error, company restored', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  const { data: preClaim, error: preClaimError } = await runner
    .from('companies')
    .select('status')
    .eq('id', companyId)
    .single();
  if (preClaimError) throw preClaimError;
  const preClaimStatus = preClaim.status;

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const child = spawnRunner(FIXTURE_HANG);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'failed', `expected job to fail on timeout, got '${finalJob.status}' (error=${finalJob.error})`);
  assert.match(finalJob.error ?? '', /timeout/i, `expected error to mention timeout, got: ${finalJob.error}`);

  const { data: company, error: companyError } = await runner
    .from('companies')
    .select('status')
    .eq('id', companyId)
    .single();
  if (companyError) throw companyError;
  assert.equal(company.status, preClaimStatus, 'expected company status restored to its pre-claim value after timeout');
});
