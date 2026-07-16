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
import { signInRunner, findOrCreateRunnerTestCo, findOrCreateCompany } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = path.join(__dirname, '..');
const INDEX = path.join(RUNNER_ROOT, 'index.mjs');
const FIXTURE_SUCCESS = path.join(__dirname, 'fixtures', 'fake-claude-success.mjs');
const FIXTURE_INVALID = path.join(__dirname, 'fixtures', 'fake-claude-invalid.mjs');
const FIXTURE_BAD_SCHEMA = path.join(__dirname, 'fixtures', 'fake-claude-bad-schema.mjs');
const FIXTURE_REPEAT = path.join(__dirname, 'fixtures', 'fake-claude-repeat.mjs');

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

test('lifecycle: a repeat suggestion (same source URL) is suppressed, job still done', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  // The repeat fixture cites the SAME url every run. History may already
  // contain it from prior suite runs (rejected facts persist as dedup log),
  // so assert on the delta: after job 1 lands, job 2 must add zero rows.
  const REPEAT_URL = 'https://runner-test.example/news/repeat-fixture';
  const countRepeatSources = async () => {
    const { count, error } = await runner
      .from('sources')
      .select('id, facts!inner(company_id)', { count: 'exact', head: true })
      .eq('facts.company_id', companyId)
      .eq('url', REPEAT_URL);
    if (error) throw error;
    return count;
  };

  const child = spawnRunner(FIXTURE_REPEAT);
  let lastJobId;
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, lastJobId);
  });

  const insertJob = async () => {
    const { data: job, error } = await runner
      .from('enrichment_jobs')
      .insert({ company_id: companyId, status: 'queued', requested_by: userId })
      .select('id')
      .single();
    if (error) throw error;
    lastJobId = job.id;
    return job.id;
  };

  const job1 = await pollUntilTerminal(runner, await insertJob());
  assert.equal(job1.status, 'done', `expected first repeat-fixture job done, got '${job1.status}' (error=${job1.error})`);
  const afterFirst = await countRepeatSources();
  assert.ok(afterFirst >= 1, 'expected the repeat URL to be on file after the first run');

  const job2 = await pollUntilTerminal(runner, await insertJob());
  assert.equal(job2.status, 'done', `expected second repeat-fixture job done, got '${job2.status}' (error=${job2.error})`);
  const afterSecond = await countRepeatSources();
  assert.equal(afterSecond, afterFirst, 'expected zero new source rows for an already-suggested URL');
});

test('lifecycle: a job stuck running at boot is not wedged (crash recovery)', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  // Simulate a crashed prior run: a job left in 'running' before this
  // runner process ever starts. Boot-time recovery must reset it to
  // 'queued' so the main loop picks it up like any other job — if
  // recovery is missing, this job stays 'running' forever and the
  // poll below times out.
  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'running', requested_by: userId, started_at: new Date().toISOString() })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const child = spawnRunner(FIXTURE_SUCCESS);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'done', `expected crash-recovered job to finish done, got '${finalJob.status}' (error=${finalJob.error})`);
});

test('lifecycle: invalid fixture fails the job with zero writes and restores company status', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  const { data: preClaim, error: preClaimError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (preClaimError) throw preClaimError;
  const preClaimStatus = preClaim.status;

  // Exact count (not just "suggested" rows) taken before the job runs, so the
  // post-run comparison proves zero facts were written of ANY status — Runner
  // Test Co is exclusively used by these tests, so an exact before/after
  // count is a safe, precise check (not just "some facts exist").
  const { count: preFactCount, error: preFactCountError } = await runner
    .from('facts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if (preFactCountError) throw preFactCountError;

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

  const { data: company, error: companyError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (companyError) throw companyError;
  assert.equal(company.status, preClaimStatus, 'expected company status restored to its pre-claim value');

  const { count: postFactCount, error: postFactCountError } = await runner
    .from('facts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if (postFactCountError) throw postFactCountError;
  assert.equal(postFactCount, preFactCount, 'expected fact count unchanged (exact before/after) on schema-validation failure');
});

test('lifecycle: a well-formed envelope with a sourceless fact fails the schema gate with zero writes', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  const { data: preClaim, error: preClaimError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (preClaimError) throw preClaimError;

  const { count: preFactCount, error: preFactCountError } = await runner
    .from('facts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if (preFactCountError) throw preFactCountError;

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const child = spawnRunner(FIXTURE_BAD_SCHEMA);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'failed', `expected job to fail, got '${finalJob.status}'`);
  // Distinguishes the layer: checkShape passed (valid envelope), the
  // hand-rolled schema walk is what rejected it.
  assert.match(finalJob.error ?? '', /schema check/, `expected a schema-check error, got: ${finalJob.error}`);

  const { data: company, error: companyError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (companyError) throw companyError;
  assert.equal(company.status, preClaim.status, 'expected company status restored to its pre-claim value');

  const { count: postFactCount, error: postFactCountError } = await runner
    .from('facts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if (postFactCountError) throw postFactCountError;
  assert.equal(postFactCount, preFactCount, 'expected zero fact writes when the nested-source gate rejects');
});

test('lifecycle: a company with a hostile domain fails input validation before any status flip', async (t) => {
  const { runner, userId } = await signInRunner();
  // Space in the domain violates validateInputs' bare-domain rule — the same
  // rule that keeps user-typed company fields from reaching the claude -p
  // prompt (trust boundary ported from test-run.sh).
  const companyId = await findOrCreateCompany(runner, userId, 'Runner Evil Co', 'evil domain.example');

  const { data: pre, error: preError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (preError) throw preError;

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  // Success fixture on purpose: if validation is doing its job, no claude
  // binary — real or fake — is ever invoked for this company.
  const child = spawnRunner(FIXTURE_SUCCESS);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'failed', `expected job to fail, got '${finalJob.status}'`);
  assert.match(finalJob.error ?? '', /invalid company inputs/, `expected an input-validation error, got: ${finalJob.error}`);

  // Never flipped (as opposed to restored): validation runs before the
  // in_progress write, so the status must be byte-identical to pre-claim.
  const { data: company, error: companyError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (companyError) throw companyError;
  assert.equal(company.status, pre.status, 'expected company status untouched by a job that failed input validation');
});
