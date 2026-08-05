// Market generate job (task 6): drive the real index.mjs against the
// in-memory stub Postgrest server (test/helpers-stub-db.mjs, task 4) — same
// reason market-lifecycle.test.mjs can't use the live-DB pattern (task 1.1's
// markets migration hasn't landed). Fake `claude` fixtures answer the bare
// runRankClaude-shaped calls (ranking + 4 bounded prose-token calls); Node
// scripts under a .py name stand in for make_spec_skeleton.py/fetch_logos.py/
// fill_deck.py (PYTHON_BIN=process.execPath) — no real claude binary, no
// real/hosted Supabase project, no python3 dependency, per the hard
// constraint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startStubSupabase } from './helpers-stub-db.mjs';
import { spawnRunner } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ENRICH_SUCCESS = path.join(__dirname, 'fixtures', 'fake-market-claude-success.mjs');
const FIXTURE_GENERATE_SUCCESS = path.join(__dirname, 'fixtures', 'fake-market-claude-generate-success.mjs');
const SCRIPTS_OK = path.join(__dirname, 'fixtures', 'market-scripts-ok');
const SCRIPTS_SKELETON_FAIL = path.join(__dirname, 'fixtures', 'market-scripts-skeleton-fail');

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
    categories: ['Denial Prevention', 'Denial Identification', 'Appeals Management'],
    customer_org_type: 'provider organizations',
    coverage_outlook: 'thin',
    coverage_note: null,
    scope_question: null,
    partial_sections: null,
    status: 'ready',
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
    kind: 'generate',
    status: 'queued',
    queue_name: 'test-market-generate',
    requested_by: stub.userId,
    claimed_by: null,
    heartbeat_at: null,
    error: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  stub.table('enrichment_jobs').push(job);
  return job;
}

function seedFact(stub, marketId, overrides = {}) {
  const fact = {
    id: randomUUID(),
    market_id: marketId,
    company_id: null,
    section: 'definition',
    text: 'fixture fact',
    fact_date: '2026-01-01',
    group_key: null,
    stats: null,
    importance: 5,
    status: 'included',
    reviewed_at: '2026-01-02T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  stub.table('facts').push(fact);
  return fact;
}

function seedSource(stub, factId, overrides = {}) {
  const source = {
    id: randomUUID(),
    fact_id: factId,
    publisher: 'Fixture Publisher',
    title: null,
    url: 'https://fixture.example/a',
    year: 2026,
    ...overrides,
  };
  stub.table('sources').push(source);
  return source;
}

// Spawns the real index.mjs pointed at the stub server, already paired
// (writeCreds). Mirrors market-lifecycle.test.mjs's spawnMarketRunner, plus
// the python-side env this job needs. MARKET_SCRIPTS_DIR is explicitly
// blanked unless a test overrides it, so a developer's real local .env
// (loaded by helpers.mjs) can never leak a real path into a test that means
// to exercise the "unset" path.
function spawnMarketRunner(stub, claudeBin, extraEnv = {}) {
  const credPath = path.join(mkdtempSync(path.join(tmpdir(), 'kr-market-gen-')), 'credentials.json');
  stub.writeCreds(credPath);
  return spawnRunner({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: stub.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon-key',
      KR_CREDENTIALS_PATH: credPath,
      CLAUDE_BIN: claudeBin,
      RUNNER_QUEUE: 'test-market-generate',
      POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
      MARKET_SCRIPTS_DIR: '',
      PYTHON_BIN: process.execPath,
      ...extraEnv,
    },
  });
}

test('market generate: success writes deck_path + deck_spec, uploads the pptx, watermark is the latest fact event', async (t) => {
  const stub = await startStubSupabase();
  const market = seedMarket(stub);

  const defFact = seedFact(stub, market.id, {
    section: 'definition',
    text: 'Denials management is the process of identifying and appealing denied insurance claims.',
    reviewed_at: '2026-01-05T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  seedSource(stub, defFact.id, { publisher: 'Fixture Standards Body' });

  const dealFact = seedFact(stub, market.id, {
    section: 'deals',
    text: 'Acme Corp acquired Widget Co in March 2026.',
    fact_date: '2026-03-15',
    stats: { type: 'acquisition', acquirer: 'Acme Corp', target: 'Widget Co', deal_value: null, announced: '2026-03-15' },
    // Latest event across every seeded fact — this is the value the
    // watermark must pick up.
    reviewed_at: '2026-03-20T00:00:00.000Z',
    created_at: '2026-03-15T00:00:00.000Z',
  });
  seedSource(stub, dealFact.id, { publisher: 'Fixture M&A Wire' });

  const vendorFact = seedFact(stub, market.id, {
    section: 'vendors',
    text: 'Acme Corp is a commercial vendor in this market.',
    stats: { type: 'player', name: 'Acme Corp', domain: null, tier: 'commercial', category: null, why: 'fixture' },
    reviewed_at: '2026-02-01T00:00:00.000Z',
    created_at: '2026-02-01T00:00:00.000Z',
  });
  seedSource(stub, vendorFact.id, { publisher: 'Fixture Vendor Directory' });

  const job = seedJob(stub, { market_id: market.id, kind: 'generate' });
  const child = spawnMarketRunner(stub, FIXTURE_GENERATE_SUCCESS, { MARKET_SCRIPTS_DIR: SCRIPTS_OK });
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'done', `expected job done, got '${finalJob?.status}' (stderr=${child.stderr()})`);
  assert.equal(finalJob.error, null);

  const updated = stub.table('markets').find((m) => m.id === market.id);
  assert.equal(updated.deck_path, `${market.id}/deck.pptx`);
  assert.ok(updated.deck_spec, 'expected deck_spec to be written');
  assert.equal(updated.deck_spec.generated_at, '2026-03-20T00:00:00.000Z', 'watermark must be the max created_at/reviewed_at across every market fact');

  // Pure-assembly tokens (buildVocabTokens + buildDealTimelineTokens).
  assert.equal(updated.deck_spec.tokens.MARKET_NAME, 'DM Test Market');
  assert.equal(updated.deck_spec.tokens.CATEGORY_1_NAME, 'Denial Prevention');
  assert.equal(updated.deck_spec.tokens.ACQUISITION_1_ACQUIRER, 'Acme Corp');
  assert.equal(updated.deck_spec.tokens.ACQUISITION_1_TARGET, 'Widget Co');
  assert.equal(updated.deck_spec.tokens.DATE_1, 'Mar 2026');

  // Bounded prose-token calls (fake-market-claude-generate-success.mjs).
  assert.equal(updated.deck_spec.tokens.MARKET_DEFINITION_QUOTE, 'A quoted fixture definition.');
  assert.equal(updated.deck_spec.tokens.EXEC_MARKET_DEFINITION, 'Fixture exec definition.');
  assert.equal(updated.deck_spec.tokens.MARKET_ACTIVITY_TAKEAWAY, 'Consolidation continues (fixture).');
  assert.equal(updated.deck_spec.tokens.THEME_1, 'PE roll-ups');
  assert.equal(updated.deck_spec.tokens.ECOSYSTEM_TIER_1_NAME, 'Regulators');
  assert.equal(updated.deck_spec.tokens.OPPORTUNITY_1_NAME, 'Automation');

  // SOURCE_CITATIONS assembled in code from each slide's section's sources.
  assert.equal(updated.deck_spec.per_slide['12'].SOURCE_CITATIONS, 'Fixture M&A Wire');
  assert.equal(updated.deck_spec.per_slide['3'].SOURCE_CITATIONS, 'Fixture Standards Body');

  // Logo fetch ran (one commercial-tier player) and landed in tier4.
  assert.deepEqual(updated.deck_spec.logos.tier4, ['Acme Corp']);

  const uploaded = stub.objects.get(`market-decks/${market.id}/deck.pptx`);
  assert.ok(uploaded, 'expected the built .pptx to be uploaded to Storage');
  assert.equal(uploaded.toString(), 'FAKE PPTX BYTES');
});

test('market generate: a python-script failure fails the job, never hangs running', async (t) => {
  const stub = await startStubSupabase();
  const market = seedMarket(stub);
  const defFact = seedFact(stub, market.id, { section: 'definition', text: 'A definition fact.' });
  seedSource(stub, defFact.id);

  const job = seedJob(stub, { market_id: market.id, kind: 'generate' });
  const child = spawnMarketRunner(stub, FIXTURE_GENERATE_SUCCESS, { MARKET_SCRIPTS_DIR: SCRIPTS_SKELETON_FAIL });
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalJob = await pollUntilTerminal(stub, job.id);
  assert.equal(finalJob.status, 'failed', `expected job failed, got '${finalJob?.status}'`);
  assert.match(finalJob.error ?? '', /make_spec_skeleton\.py failed/, `expected a clear script-failure error, got: ${finalJob?.error}`);

  const updated = stub.table('markets').find((m) => m.id === market.id);
  assert.equal(updated.deck_path, null, 'expected no deck_path written on a failed build');
});

test('market generate: a missing MARKET_SCRIPTS_DIR fails only that job — the runner keeps processing other jobs', async (t) => {
  const stub = await startStubSupabase();
  const genMarket = seedMarket(stub);
  const defFact = seedFact(stub, genMarket.id, { section: 'definition', text: 'A definition fact.' });
  seedSource(stub, defFact.id);
  const genJob = seedJob(stub, { market_id: genMarket.id, kind: 'generate' });

  // MARKET_SCRIPTS_DIR stays unset (spawnMarketRunner's default) — this
  // runner's whole process never has it, proving the check fires before any
  // python/claude call, not just in isolation.
  const child = spawnMarketRunner(stub, FIXTURE_ENRICH_SUCCESS);
  t.after(async () => {
    child.kill('SIGKILL');
    await stub.close();
  });

  const finalGenJob = await pollUntilTerminal(stub, genJob.id);
  assert.equal(finalGenJob.status, 'failed', `expected job failed, got '${finalGenJob?.status}'`);
  assert.match(finalGenJob.error ?? '', /MARKET_SCRIPTS_DIR is not set/, `expected a clear MARKET_SCRIPTS_DIR error, got: ${finalGenJob?.error}`);

  // Same runner process, a second and unrelated market job: proves the
  // failure above didn't crash the runner or wedge the queue.
  const enrichMarket = seedMarket(stub, { status: 'queued' });
  const enrichJob = seedJob(stub, { market_id: enrichMarket.id, kind: 'enrich' });
  const finalEnrichJob = await pollUntilTerminal(stub, enrichJob.id);
  assert.equal(finalEnrichJob.status, 'done', `expected the second job to complete normally, got '${finalEnrichJob?.status}' (stderr=${child.stderr()})`);
});
