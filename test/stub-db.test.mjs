// Smoke test for the stub itself (task 4's own scope, per PLAN.json): proves
// the in-memory PostgREST-shaped server actually speaks the wire protocol
// supabase-js sends, using the REAL @supabase/supabase-js client (the same
// package index.mjs uses) rather than hand-rolled fetch calls — tasks 5/6
// will spawn the real index.mjs against this exact stub, so if supabase-js
// can't round-trip through it here, it won't there either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { startStubSupabase } from './helpers-stub-db.mjs';

async function withStub(fn) {
  const stub = await startStubSupabase();
  try {
    const client = createClient(stub.url, 'stub-anon-key');
    await fn(stub, client);
  } finally {
    await stub.close();
  }
}

test('insert a market, then read it back by id', () =>
  withStub(async (stub, client) => {
    const { data: inserted, error: insertError } = await client
      .from('markets')
      .insert({ name: 'Ambulatory Surgery Centers', geography: 'US', status: 'queued' })
      .select()
      .single();
    assert.equal(insertError, null);
    assert.equal(inserted.name, 'Ambulatory Surgery Centers');
    assert.ok(inserted.id, 'insert must assign an id');

    const { data: read, error: readError } = await client
      .from('markets')
      .select('*')
      .eq('id', inserted.id)
      .single();
    assert.equal(readError, null);
    assert.equal(read.name, 'Ambulatory Surgery Centers');
    assert.equal(read.status, 'queued');
  }));

test('guarded-write claim: eq-guarded update returns the row and flips its status', () =>
  withStub(async (stub, client) => {
    const jobId = 'job-1';
    stub.table('enrichment_jobs').push({ id: jobId, market_id: 'm-1', status: 'queued', queue_name: 'test-q', requested_by: stub.userId, claimed_by: null });

    const { data: claimed, error } = await client
      .from('enrichment_jobs')
      .update({ status: 'running', claimed_by: 'worker-1' })
      .eq('id', jobId)
      .eq('status', 'queued')
      .eq('queue_name', 'test-q')
      .select();
    assert.equal(error, null);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, 'running');
    assert.equal(stub.table('enrichment_jobs')[0].claimed_by, 'worker-1');
  }));

test('guarded-write claim: a lost race (status no longer queued) matches zero rows, no throw', () =>
  withStub(async (stub, client) => {
    const jobId = 'job-2';
    stub.table('enrichment_jobs').push({ id: jobId, status: 'running', queue_name: 'test-q', claimed_by: 'someone-else' });

    const { data: claimed, error } = await client
      .from('enrichment_jobs')
      .update({ status: 'running', claimed_by: 'worker-1' })
      .eq('id', jobId)
      .eq('status', 'queued') // guard fails: row is already 'running'
      .select();
    assert.equal(error, null);
    assert.equal(claimed.length, 0, 'a sibling worker already claimed this row');
    assert.equal(stub.table('enrichment_jobs')[0].claimed_by, 'someone-else', 'unmatched row must be untouched');
  }));

test('facts with market_id: .eq + .in filters scope to the right parent and sections', () =>
  withStub(async (stub, client) => {
    stub.table('facts').push(
      { id: 'f1', market_id: 'm-1', company_id: null, section: 'market_size', status: 'included' },
      { id: 'f2', market_id: 'm-1', company_id: null, section: 'vendors', status: 'included' },
      { id: 'f3', market_id: 'm-2', company_id: null, section: 'market_size', status: 'included' },
      { id: 'f4', market_id: null, company_id: 'c-1', section: 'market_size', status: 'included' }
    );

    const { data, error } = await client
      .from('facts')
      .select('id, section')
      .eq('market_id', 'm-1')
      .eq('status', 'included')
      .in('section', ['market_size', 'vendors']);
    assert.equal(error, null);
    assert.deepEqual(new Set(data.map((r) => r.id)), new Set(['f1', 'f2']));
  }));

test('crash-recovery .or() query: matches null-heartbeat OR stale-heartbeat rows only', () =>
  withStub(async (stub, client) => {
    const staleCutoff = new Date(Date.now() - 1000).toISOString();
    stub.table('enrichment_jobs').push(
      { id: 'stale-null', status: 'running', queue_name: 'q', heartbeat_at: null },
      { id: 'stale-old', status: 'running', queue_name: 'q', heartbeat_at: new Date(Date.now() - 5000).toISOString() },
      { id: 'fresh', status: 'running', queue_name: 'q', heartbeat_at: new Date(Date.now() + 5000).toISOString() }
    );

    const { data, error } = await client
      .from('enrichment_jobs')
      .update({ status: 'queued', claimed_by: null, heartbeat_at: null })
      .eq('status', 'running')
      .eq('queue_name', 'q')
      .or(`heartbeat_at.is.null,heartbeat_at.lt.${staleCutoff}`)
      .select('id');
    assert.equal(error, null);
    assert.deepEqual(new Set(data.map((r) => r.id)), new Set(['stale-null', 'stale-old']));
  }));

test('order + limit: queued jobs come back oldest-first, capped', () =>
  withStub(async (stub, client) => {
    stub.table('enrichment_jobs').push(
      { id: 'j3', status: 'queued', queue_name: 'q', requested_by: 'u', created_at: '2026-01-03T00:00:00Z' },
      { id: 'j1', status: 'queued', queue_name: 'q', requested_by: 'u', created_at: '2026-01-01T00:00:00Z' },
      { id: 'j2', status: 'queued', queue_name: 'q', requested_by: 'u', created_at: '2026-01-02T00:00:00Z' }
    );
    const { data, error } = await client
      .from('enrichment_jobs')
      .select('*')
      .eq('status', 'queued')
      .eq('queue_name', 'q')
      .eq('requested_by', 'u')
      .order('created_at')
      .limit(2);
    assert.equal(error, null);
    assert.deepEqual(data.map((r) => r.id), ['j1', 'j2']);
  }));

test('auth stub: refreshSession round-trips a session (the pattern ensureSession() uses)', () =>
  withStub(async (stub, client) => {
    const { data, error } = await client.auth.refreshSession({ refresh_token: 'anything' });
    assert.equal(error, null);
    assert.equal(data.session.user.id, stub.userId);
    assert.equal(data.session.refresh_token, 'stub-refresh-token');
  }));

test('storage upload stub: records the blob in memory and returns a path', () =>
  withStub(async (stub, client) => {
    const { data, error } = await client.storage.from('decks').upload('m-1/deck.pptx', Buffer.from('fake pptx bytes'));
    assert.equal(error, null);
    assert.ok(data.path);
    assert.ok(stub.objects.has('decks/m-1/deck.pptx'), 'uploaded blob must be recorded under bucket/path');
    assert.equal(stub.objects.get('decks/m-1/deck.pptx').toString(), 'fake pptx bytes');
  }));
