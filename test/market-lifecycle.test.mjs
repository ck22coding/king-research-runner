// Market enrich lifecycle: drive the real index.mjs (spawned as a child
// process) against the in-memory stub Postgrest server (test/helpers-stub-db.mjs,
// task 4) rather than the live/hosted Supabase project — the migration that
// would create markets/market_id doesn't exist there yet (task 1.1 hasn't
// landed), which is exactly why this can't reuse lifecycle.test.mjs's
// live-DB pattern. Fake `claude` fixtures answer the market-jumpstart
// prompts (test/fixtures/fake-market-claude-*.mjs); no real claude binary,
// no real/hosted Supabase project — per the hard constraint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startStubSupabase } from './helpers-stub-db.mjs';
import { spawnRunner, TEST_QUEUE } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SUCCESS = path.join(__dirname, 'fixtures', 'fake-market-claude-success.mjs');
const FIXTURE_SCOPE_QUESTION = path.join(__dirname, 'fixtures', 'fake-market-claude-scope-question.mjs');
const FIXTURE_PARTIAL = path.join(__dirname, 'fixtures', 'fake-market-claude-partial.mjs');
const FIXTURE_ALL_FAIL = path.join(__dirname, 'fixtures', 'fake-market-claude-all-fail.mjs');
const FIXTURE_SLOW_SCOUT = path.join(__dirname, 'fixtures', 'fake-market-claude-slow-scout.mjs');
// Any claude fixture works for the malformed-job test — the guard must fire
// before a single claude process is ever spawned.
const FIXTURE_UNUSED = FIXTURE_SUCCESS;

const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 10_000;

async function pollUntilTerminal(stub, jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let job;
  do {
    job = stub.table('enrichment_jobs').find((r) => r.id === jobId);
    if (job && (job.status === 'done' || job.status === 'failed')) return job;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return job;
}

function seedMarket(stub, overrides = {}) {
  const market = {
    id: randomUUID(),
    name: 'DM Test Market',
    geography: 'US',
    parent_market: null,
    includes: null,
    excludes: null,
    categories: null,
    customer_org_type: null,
    coverage_outlook: null,
    coverage_note: null,
    scope_question: null,
    partial_sections: null,
    status: 'queued',
    deck_spec: null,
    deck_path: null,
    created_by: stub.userId,
    ...overrides,
  };
  stub.table('markets').push(market);
  return market;
}

function seedJob(stub, overrides = {}) {
  const job = {
    id: randomUUID(),
    market_id: null,
    company_id: null,
    kind: 'enrich',
    status: 'queued',
    queue_name: 'test-market',
    requested_by: stub.userId,
    claimed_by: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  stub.table('enrichment_jobs').push(job);
  return job;
}

// Spawns the real index.mjs pointed at the stub server, already paired
// (writeCreds), with a fake claude binary standing in for the market-jumpstart
// skill. RUNNER_QUEUE/POLL_INTERVAL_MS narrow + speed up the poll loop; every
// other env comes from the running process (PLUGIN_DIR etc. from helpers.mjs)
// but NEXT_PUBLIC_SUPABASE_URL/ANON_KEY here override it to point at the stub
// instead of the real project.
function spawnMarketRunner(stub, claudeBin, extraEnv = {}) {
  const credPath = path.join(mkdtempSync(path.join(tmpdir(), 'kr-market-')), 'credentials.json');
  stub.writeCreds(credPath);
  return spawnRunner({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: stub.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon-key',
      KR_CREDENTIALS_PATH: credPath,
      CLAUDE_BIN: claudeBin,
      RUNNER_QUEUE: 'test-market',
      POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
      ...extraEnv,
    },
  });
}

function factsForMarket(stub, marketId) {
  return stub.table('facts').filter((f) => f.market_id === marketId);
}

test('market enrich: full success lands facts under market_id, writes the shared vocabulary, job done', async (t) => {
  const stub = await startStubSupabase();
  const market = seedMarket(stub);
  const job = seedJob(stub, { market_id: market.id });
  const child = spawnMarketRunner(stub, FIXTURE_SUCCESS);
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'done', `expected job done, got '${finalJob?.status}' (stderr=${child.stderr()})`);
  assert.equal(finalJob.error, null, 'expected no partial note on a full success');

  const facts = factsForMarket(stub, market.id);
  assert.equal(facts.length, 1, 'expected exactly the one market_size fact');
  assert.equal(facts[0].status, 'included');
  assert.equal(facts[0].company_id, null, 'a market fact must never also carry a company_id');

  const sources = stub.table('sources').filter((s) => facts.some((f) => f.id === s.fact_id));
  assert.equal(sources.length, 1, 'expected the fact\'s one source to be inserted');

  const updated = stub.table('markets').find((m) => m.id === market.id);
  assert.equal(updated.status, 'ready');
  assert.equal(updated.name, 'DM Test Market', 'markets.name must never be overwritten by the scout\'s canonical_market');
  assert.deepEqual(updated.categories, ['Denial Prevention', 'Denial Identification', 'Appeals Management']);
  assert.equal(updated.customer_org_type, 'provider organizations');
  assert.equal(updated.coverage_outlook, 'thin');
  assert.equal(updated.partial_sections, null, 'expected no partial_sections on a full success');
});

test('market enrich: a scope question stops before any topic node — status stays queued, no facts written', async (t) => {
  const stub = await startStubSupabase();
  const market = seedMarket(stub);
  const job = seedJob(stub, { market_id: market.id });
  const child = spawnMarketRunner(stub, FIXTURE_SCOPE_QUESTION);
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'done', `expected job done (scope question is not a failure), got '${finalJob?.status}'`);

  const updated = stub.table('markets').find((m) => m.id === market.id);
  assert.equal(
    updated.scope_question,
    'All of revenue cycle management, or just denials management?',
    'expected the clarifying question written to markets.scope_question'
  );
  assert.equal(updated.status, 'queued', 'expected status explicitly reset to queued, never ready, on a scope question');
  assert.equal(updated.categories, null, 'the shared vocabulary must not be written when the scout never resolved scope');

  assert.equal(factsForMarket(stub, market.id).length, 0, 'expected zero facts written — no topic node should run');
});

test('market enrich: one dead topic node yields a partial assessment, not a failed job', async (t) => {
  const stub = await startStubSupabase();
  const market = seedMarket(stub);
  const job = seedJob(stub, { market_id: market.id });
  const child = spawnMarketRunner(stub, FIXTURE_PARTIAL);
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'done', `expected a partial run to still finish done, got '${finalJob?.status}' (stderr=${child.stderr()})`);
  assert.match(finalJob.error ?? '', /partial: vendors/, `expected the job to record which section was lost, got: ${finalJob?.error}`);

  const updated = stub.table('markets').find((m) => m.id === market.id);
  assert.equal(updated.status, 'ready', 'expected a partial run to still mark the market ready');
  assert.deepEqual(updated.partial_sections, ['vendors']);

  const facts = factsForMarket(stub, market.id);
  assert.equal(facts.length, 1, 'expected the surviving market_size section\'s fact to still be written');
});

test('market enrich: every topic node failing is a total loss — job fails, market status restored', async (t) => {
  const stub = await startStubSupabase();
  const market = seedMarket(stub, { status: 'queued' });
  const job = seedJob(stub, { market_id: market.id });
  const child = spawnMarketRunner(stub, FIXTURE_ALL_FAIL);
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'failed', `expected job failed, got '${finalJob?.status}'`);
  assert.match(finalJob.error ?? '', /every market topic node failed/, `expected a clear total-loss error, got: ${finalJob?.error}`);

  const updated = stub.table('markets').find((m) => m.id === market.id);
  assert.equal(updated.status, 'queued', 'expected market status restored to its pre-claim value');
  assert.equal(factsForMarket(stub, market.id).length, 0, 'expected zero facts written on a total loss');
});

test('malformed job: both company_id and market_id set fails immediately rather than hanging', async (t) => {
  const stub = await startStubSupabase();
  const job = seedJob(stub, { market_id: randomUUID(), company_id: randomUUID() });
  const child = spawnMarketRunner(stub, FIXTURE_UNUSED);
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'failed', `expected job failed, got '${finalJob?.status}'`);
  assert.match(finalJob.error ?? '', /malformed job/, `expected a malformed-job error, got: ${finalJob?.error}`);
});

test('malformed job: neither company_id nor market_id set fails immediately rather than hanging', async (t) => {
  const stub = await startStubSupabase();
  const job = seedJob(stub, { market_id: null, company_id: null });
  const child = spawnMarketRunner(stub, FIXTURE_UNUSED);
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'failed', `expected job failed, got '${finalJob?.status}'`);
  assert.match(finalJob.error ?? '', /malformed job/, `expected a malformed-job error, got: ${finalJob?.error}`);
});

// Regression for the in-process dedup guard keying in-flight jobs by
// company_id: every market job has company_id === null, and a Set treats
// null as a real member, so once one market job is in flight ANY other
// market's job — not just the same market's — gets filtered out of every
// future poll until the first job's finally block clears it. Two workers
// (RUNNER_CONCURRENCY=2) against two DIFFERENT markets must run both jobs
// concurrently, not serially.
test('market enrich: two different markets run concurrently, not serialized by a shared null company_id key', async (t) => {
  const stub = await startStubSupabase();
  const marketA = seedMarket(stub);
  const marketB = seedMarket(stub);
  const jobA = seedJob(stub, { market_id: marketA.id });
  const jobB = seedJob(stub, { market_id: marketB.id });
  const child = spawnMarketRunner(stub, FIXTURE_SLOW_SCOUT, { RUNNER_CONCURRENCY: '2' });
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  // Both jobs' fake scout call sleeps 2s, so a fixed runner has a wide window
  // to claim and run both concurrently. Sample statuses across that window
  // rather than asserting on a single snapshot, since the exact claim order
  // between two workers racing the poll is not deterministic.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let sawBothRunning = false;
  let statusA;
  let statusB;
  do {
    statusA = stub.table('enrichment_jobs').find((r) => r.id === jobA.id)?.status;
    statusB = stub.table('enrichment_jobs').find((r) => r.id === jobB.id)?.status;
    if (statusA === 'running' && statusB === 'running') sawBothRunning = true;
    if ((statusA === 'done' || statusA === 'failed') && (statusB === 'done' || statusB === 'failed')) break;
    await sleep(50);
  } while (Date.now() < deadline);

  assert.equal(
    sawBothRunning,
    true,
    `expected both jobs to be 'running' at the same time at least once (last seen: A=${statusA}, B=${statusB}) — ` +
      'if this is false, a market job is blocking every other market\'s jobs via the null company_id dedup key'
  );
  assert.equal(statusA, 'done', `expected market A's job done, got '${statusA}'`);
  assert.equal(statusB, 'done', `expected market B's job done, got '${statusB}'`);
});
