// Lifecycle tests: drive the real index.mjs (spawned as a child process)
// against the live Supabase project as the runner user, pointed at a fake
// CLAUDE_BIN so no real claude -p run happens. Written RED, before the
// claim/run/write loop exists — index.mjs today only signs in and sleeps,
// so every job here stays 'queued' forever and the terminal-status poll
// below times out. That's the expected failure shape for this commit; a
// crash (thrown error, hung process, unhandled rejection) would not be.
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
const FIXTURE_SUCCESS = path.join(__dirname, 'fixtures', 'fake-claude-success.mjs');
const FIXTURE_INVALID = path.join(__dirname, 'fixtures', 'fake-claude-invalid.mjs');

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

function spawnRunner(claudeBin) {
  const env = { ...process.env, CLAUDE_BIN: claudeBin, POLL_INTERVAL_MS: String(POLL_INTERVAL_MS) };
  return spawn(process.execPath, [INDEX], { cwd: RUNNER_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function killChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// Polls the job row every ~1s until it reaches a terminal status (done /
// failed) or POLL_TIMEOUT_MS elapses, whichever first — returns whatever the
// row looks like at that point rather than throwing, so a timeout surfaces
// as a clean assertion failure ("expected done, got queued") in the caller.
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

// ponytail: cleanup rejects every fact on this company rather than tracking
// per-run ids — Runner Test Co exists solely for these tests, so blanket
// cleanup is safe and mirrors enrich-e2e.spec.ts's afterAll. Also parks any
// job this run left non-terminal so a later real runner never claims it.
async function cleanup(runner, companyId, jobId) {
  await runner.from('facts').update({ status: 'rejected' }).eq('company_id', companyId);
  await runner
    .from('enrichment_jobs')
    .update({ status: 'failed', error: 'test cleanup: lifecycle harness run', finished_at: new Date().toISOString() })
    .eq('id', jobId)
    .in('status', ['queued', 'running']);
}

test('lifecycle: success fixture takes a queued job to done with suggested facts', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const child = spawnRunner(FIXTURE_SUCCESS);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'done', `expected job to finish done, got '${finalJob.status}' (error=${finalJob.error})`);

  const { data: facts, error: factsError } = await runner
    .from('facts')
    .select('id, status, sources(id)')
    .eq('company_id', companyId)
    .eq('status', 'suggested');
  if (factsError) throw factsError;
  assert.ok(facts.length >= 1, 'expected at least one suggested fact inserted');
  for (const fact of facts) {
    assert.ok(fact.sources.length >= 1, `expected fact ${fact.id} to have at least one source`);
  }

  const { data: company, error: companyError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (companyError) throw companyError;
  assert.equal(company.status, 'ready');
});

test('lifecycle: invalid fixture fails the job with zero writes and restores company status', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  const { data: preClaim, error: preClaimError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (preClaimError) throw preClaimError;
  const preClaimStatus = preClaim.status;

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const child = spawnRunner(FIXTURE_INVALID);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'failed', `expected job to fail, got '${finalJob.status}'`);
  assert.ok(finalJob.error && finalJob.error.length > 0, 'expected job.error to record the failure reason');

  const { data: facts, error: factsError } = await runner.from('facts').select('id').eq('company_id', companyId).eq('status', 'suggested');
  if (factsError) throw factsError;
  assert.equal(facts.length, 0, 'expected zero facts written on schema-validation failure');

  const { data: company, error: companyError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (companyError) throw companyError;
  assert.equal(company.status, preClaimStatus, "expected company status restored to its pre-claim value");
});
