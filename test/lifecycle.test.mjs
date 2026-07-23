// Lifecycle tests: drive the real index.mjs (spawned as a child process)
// against the live Supabase project as the runner user, pointed at a fake
// CLAUDE_BIN so no real claude -p run happens. Written RED, before the
// claim/run/write loop exists — index.mjs today only signs in and sleeps,
// so every job here stays 'queued' forever and the terminal-status poll
// below times out. That's the expected failure shape for this commit; a
// crash (thrown error, hung process, unhandled rejection) would not be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signInRunner, signInTestUser, spawnPaired, findOrCreateRunnerTestCo, findOrCreateCompany } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SUCCESS = path.join(__dirname, 'fixtures', 'fake-claude-success.mjs');
const FIXTURE_INVALID = path.join(__dirname, 'fixtures', 'fake-claude-invalid.mjs');
const FIXTURE_BAD_SCHEMA = path.join(__dirname, 'fixtures', 'fake-claude-bad-schema.mjs');
const FIXTURE_REPEAT = path.join(__dirname, 'fixtures', 'fake-claude-repeat.mjs');
const FIXTURE_PARTIAL = path.join(__dirname, 'fixtures', 'fake-claude-partial.mjs');
const FIXTURE_RECORD = path.join(__dirname, 'fixtures', 'fake-claude-record.mjs');

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

// Pairs the spawned runner as the SAME fixture user signInRunner()'s caller
// uses (so its requested_by = ME.id claims match the fixture jobs below) —
// index.mjs no longer reads RUNNER_EMAIL/RUNNER_PASSWORD (Task 5), so
// passing CLAUDE_BIN/POLL_INTERVAL_MS alone is no longer enough to get it
// signed in.
async function spawnRunner(claudeBin) {
  const session = await signInTestUser();
  return spawnPaired(session, { CLAUDE_BIN: claudeBin, POLL_INTERVAL_MS: String(POLL_INTERVAL_MS) });
}

// spawnPaired's handle wraps the child process (no raw exitCode/signalCode);
// its .kill() is a harmless no-op if the process already exited.
function killChild(child) {
  child.kill('SIGKILL');
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
  await runner.from('facts').update({ status: 'removed' }).eq('company_id', companyId);
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

  const child = await spawnRunner(FIXTURE_SUCCESS);
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
    .eq('status', 'included');
  if (factsError) throw factsError;
  assert.ok(facts.length >= 1, 'expected at least one included fact inserted');
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

  const child = await spawnRunner(FIXTURE_REPEAT);
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

// The money table (spec §6) is the whole point of the fan-out — per-topic
// models and fetch caps are what bound the cost. A table nobody checks is a
// comment, so this asserts what actually reached the `claude -p` argv.
test('fan-out: every node is spawned with its own model and fetch budget', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);
  const recordFile = path.join(mkdtempSync(path.join(tmpdir(), 'kr-rec-')), 'nodes.tsv');

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const session = await signInTestUser();
  const child = spawnPaired(session, {
    CLAUDE_BIN: FIXTURE_RECORD,
    POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
    KR_RECORD_FILE: recordFile,
  });
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'done', `expected the recording run to finish, got '${finalJob.status}' (error=${finalJob.error})`);

  const spawned = new Map(
    readFileSync(recordFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [kind, model, budget] = line.split('\t');
        return [kind, { model, budget }];
      })
  );

  // Straight from the spec's §6 table.
  const EXPECTED = {
    scout: { model: 'haiku', budget: '2' },
    'topic:leadership': { model: 'haiku', budget: '4' },
    'topic:news': { model: 'haiku', budget: '6' },
    'topic:growth_signals': { model: 'haiku', budget: '4' },
    'topic:acquisitions_partnerships': { model: 'sonnet', budget: '6' },
    'topic:financials': { model: 'sonnet', budget: '8' },
    'topic:risk_flags': { model: 'sonnet', budget: '5' },
  };
  for (const [node, want] of Object.entries(EXPECTED)) {
    assert.deepEqual(spawned.get(node), want, `node '${node}' was not spawned per the spec's model/fetch-cap table`);
  }
  assert.equal(spawned.size, 7, 'expected exactly the scout plus six topic nodes — no extra research calls');
});

// The tldr node is the one call that runs with NO plugin loaded, so SKILL.md's
// "no preamble, no summary, no 'here's what I found'" rule is absent. With the
// bundled description ("2-3 sentence summary per tldr-contract.md") the model
// reads "summary" as "summary of the work I just did" and writes
// "Wrote a 3-sentence TL;DR following the contract..." straight into
// companies.tldr — user-visible on the brief and the PDF. Caught on a live
// Medtronic run; an A/B there showed prompt wording alone does NOT fix it (the
// field description outranks the prompt body), so the override is the fix and
// this asserts it actually reaches the argv.
test('tldr node: its schema demands the prose itself, not a report about it', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);
  const schemaFile = path.join(mkdtempSync(path.join(tmpdir(), 'kr-tldr-')), 'schema.json');

  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'queued', requested_by: userId })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const session = await signInTestUser();
  const child = spawnPaired(session, {
    CLAUDE_BIN: FIXTURE_RECORD,
    POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
    KR_TLDR_SCHEMA_FILE: schemaFile,
  });
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'done', `expected the tldr-schema run to finish, got '${finalJob.status}' (error=${finalJob.error})`);

  const description = JSON.parse(readFileSync(schemaFile, 'utf8')).properties.tldr.description;
  assert.match(
    description,
    /never a report of what you did/i,
    'the tldr node must override the bundled schema description — without it the model returns a report about the summary instead of the summary'
  );
  assert.doesNotMatch(
    description,
    /^2-3 sentence summary per tldr-contract\.md\.$/,
    'the tldr node is still passing the bundled full-run description, which regresses the meta-commentary bug'
  );
});

// Failure containment (spec §10): before the topic graph, one section
// stumbling failed the whole schema-gated array and lost all six. Now a dead
// topic node costs exactly that topic — the job completes as a partial and
// names what was lost, loudly, in the job row.
test('lifecycle: one dead topic node yields a partial report, not a failed job', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

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

  const child = await spawnRunner(FIXTURE_PARTIAL);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'done', `expected a partial run to still finish done, got '${finalJob.status}' (error=${finalJob.error})`);
  assert.match(finalJob.error ?? '', /partial: financials/, `expected the job to record which section was lost, got: ${finalJob.error}`);

  // The surviving sections' work is the whole point — it must be written.
  const { count: postFactCount, error: postFactCountError } = await runner
    .from('facts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if (postFactCountError) throw postFactCountError;
  assert.ok(postFactCount > preFactCount, 'expected the surviving sections to still write their facts');

  const { data: company, error: companyError } = await runner.from('companies').select('status').eq('id', companyId).single();
  if (companyError) throw companyError;
  assert.equal(company.status, 'ready', 'expected a partial run to still mark the company ready');
});

test('lifecycle: a job stuck running at boot is not wedged (crash recovery)', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  // Simulate a crashed prior run: a job left 'running' with a started_at far
  // enough in the past that it can only be a crashed run, never a genuinely
  // in-flight one (see index.mjs's CRASH_RECOVERY_STALE_MS — comfortably
  // under an hour even at the default 20-minute CLAUDE_TIMEOUT_MS, so 3
  // hours ago is unambiguously stale). Boot-time recovery must reset it to
  // 'queued' so the main loop picks it up like any other job — if recovery
  // is missing (or the staleness gate wrongly excludes it), this job stays
  // 'running' forever and the poll below times out.
  const staleStartedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({ company_id: companyId, status: 'running', requested_by: userId, started_at: staleStartedAt })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const child = await spawnRunner(FIXTURE_SUCCESS);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  const finalJob = await pollUntilTerminal(runner, job.id);
  assert.equal(finalJob.status, 'done', `expected crash-recovered job to finish done, got '${finalJob.status}' (error=${finalJob.error})`);
});

test('lifecycle: a fresh running job is left alone by a concurrently-started instance (no double-run)', async (t) => {
  const { runner, userId } = await signInRunner();
  const companyId = await findOrCreateRunnerTestCo(runner, userId);

  // Simulates a second instance starting while a first is genuinely mid-job
  // (e.g. two runs overlapping): since the lease redesign, "genuinely
  // in-flight" means a FRESH HEARTBEAT — recovery sweeps running rows whose
  // heartbeat_at is NULL or stale, so this row carries a live lease from a
  // pretend sibling worker. Boot crash-recovery on the new instance must
  // NOT reset it — that would yank an in-flight job back to 'queued', where
  // it could be re-claimed and re-run: real, paid research executed twice.
  const now = new Date().toISOString();
  const { data: job, error: jobError } = await runner
    .from('enrichment_jobs')
    .insert({
      company_id: companyId,
      status: 'running',
      requested_by: userId,
      started_at: now,
      claimed_by: 'lifecycle-test-sibling-worker',
      heartbeat_at: now,
    })
    .select('id')
    .single();
  if (jobError) throw jobError;

  const child = await spawnRunner(FIXTURE_SUCCESS);
  t.after(async () => {
    killChild(child);
    await cleanup(runner, companyId, job.id);
  });

  // The new instance's boot-time reset runs once, synchronously, before its
  // poll loop starts — give it a moment, then confirm the job is untouched
  // (still 'running', not bounced back to 'queued' and picked up again).
  await sleep(3000);
  const { data: stillRunning, error: stillRunningError } = await runner
    .from('enrichment_jobs')
    .select('status')
    .eq('id', job.id)
    .single();
  if (stillRunningError) throw stillRunningError;
  assert.equal(
    stillRunning.status,
    'running',
    'expected a fresh running job to be left alone by a concurrently-started instance'
  );
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

  const child = await spawnRunner(FIXTURE_INVALID);
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

  const child = await spawnRunner(FIXTURE_BAD_SCHEMA);
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
  const child = await spawnRunner(FIXTURE_SUCCESS);
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
