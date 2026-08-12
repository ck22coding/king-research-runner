// Per-user claims + presence heartbeat. Drives the real index.mjs (via
// helpers' spawnPaired) and the live Supabase project. Two things locked
// down here: (1) RLS — the requester-only update policy on enrichment_jobs
// (migration 20260723120000_per_user_runners.sql) must keep user B from
// claiming user A's job, proven directly against the DB with no runner
// process involved; (2) the runner upserts its own presence row on an
// interval while it polls (web's "runner offline" banner keys off this).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import {
  supabase,
  signInTestUser,
  adminCreateThrowawayUser,
  adminDeleteUser,
  findOrCreateRunnerTestCo,
  spawnPaired,
  TEST_QUEUE,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Never the real claude binary: any job this test's spawned runner ends up
// claiming (this one, or a stray left by a prior failed run) must not
// trigger real, paid research (see runner/README.md "Operational notes").
const FIXTURE_SUCCESS = path.join(__dirname, 'fixtures', 'fake-claude-success.mjs');

test('RLS: user B cannot claim user A job', async () => {
  const a = await signInTestUser();
  const companyId = await findOrCreateRunnerTestCo(supabase, a.user.id);
  const { data: job, error: jobError } = await supabase
    .from('enrichment_jobs')
    .insert({ queue_name: TEST_QUEUE, company_id: companyId, requested_by: a.user.id })
    .select()
    .single();
  if (jobError) throw jobError;

  // Job cleanup must run no matter what happens below — an uncaught throw
  // here would leave it 'queued' forever, tripping the one-active-job-per-
  // company constraint for every later test AND leaving something a real
  // runner could claim and burn real API cost on.
  try {
    const b = await adminCreateThrowawayUser();
    try {
      const asB = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
      const { error: signInError } = await asB.auth.signInWithPassword({ email: b.email, password: b.password });
      if (signInError) throw signInError;
      const { data: stolen, error: stealError } = await asB
        .from('enrichment_jobs')
        .update({ status: 'running', claimed_by: 'thief' })
        .eq('id', job.id)
        .eq('status', 'queued')
        .select();
      if (stealError) throw stealError;
      assert.equal(stolen.length, 0, "RLS must hide A's job from B's UPDATE");
    } finally {
      await adminDeleteUser(b.id);
    }
  } finally {
    await supabase
      .from('enrichment_jobs')
      .update({ status: 'failed', error: 'test cleanup', finished_at: new Date().toISOString() })
      .eq('id', job.id);
  }
});

test('runner heartbeats while polling', async () => {
  const a = await signInTestUser();
  const before = new Date().toISOString();
  const child = await spawnPaired(a, { POLL_INTERVAL_MS: '1000', CLAUDE_BIN: FIXTURE_SUCCESS });
  try {
    await child.waitForLine(/signed in as /, 15_000);
    await sleep(4000);
    const { data: hb, error: hbError } = await supabase
      .from('runner_heartbeats')
      .select('last_seen_at')
      .eq('user_id', a.user.id)
      .single();
    if (hbError) throw hbError;
    assert.ok(hb && hb.last_seen_at > before, 'heartbeat row must be freshly upserted');
  } finally {
    child.kill();
  }
});
