// The merge edge is the one piece of the diamond with no model in the loop
// and no DB behind it — pure logic, so it gets a pure test. No Supabase, no
// fake claude, no network: runs in milliseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTopicFacts, riskyReason, normalizeUrl } from '../lib/topic-graph.mjs';

const src = (url, publisher = 'Test Wire') => ({ publisher, title: null, url, year: 2026 });
const fact = (over = {}) => ({
  section: 'news',
  text: 'A thing happened.',
  fact_date: '2026-07-01',
  group_key: null,
  importance: 5,
  stats: null,
  sources: [src('https://example.com/a')],
  ...over,
});
const node = (section, facts) => ({ section, facts, notes: null });

test('merge: same group_key across two sections collapses to one fact', () => {
  const { facts, mergedCount } = mergeTopicFacts([
    node('financials', [fact({ section: 'financials', group_key: 'acme-series-c', importance: 9, sources: [src('https://tc.example/a')] })]),
    node('news', [fact({ section: 'news', group_key: 'acme-series-c', importance: 4, sources: [src('https://wsj.example/b')] })]),
  ]);
  assert.equal(facts.length, 1, 'expected one merged fact');
  assert.equal(mergedCount, 1);
  assert.equal(facts[0].section, 'financials', 'first-seen section wins');
  assert.equal(facts[0].sources.length, 2, 'sources unioned across sections');
  assert.equal(facts[0].importance, 9, 'importance takes the max, not the last');
});

// The edge the spec calls out: independently-run sections slug the same story
// differently, so group_key alone misses it and URL overlap has to catch it.
test('merge: different group_keys but an overlapping source URL still collapse', () => {
  const { facts } = mergeTopicFacts([
    node('news', [fact({ group_key: 'acme-raise', sources: [src('https://tc.example/story')] })]),
    node('financials', [
      fact({
        section: 'financials',
        group_key: 'acme-series-c',
        sources: [src('https://tc.example/story?utm_source=x'), src('https://wsj.example/b')],
      }),
    ]),
  ]);
  assert.equal(facts.length, 1, 'URL overlap must catch what group_key missed');
  assert.equal(facts[0].sources.length, 2, 'the shared URL is not duplicated');
});

// Grouping has to be transitive (codex review): the third fact is the only
// thing connecting the first two, and picking a single match would leave the
// story split across two facts — the exact duplicate this edge removes.
test('merge: a fact bridging two existing groups collapses all three', () => {
  const { facts } = mergeTopicFacts([
    node('news', [fact({ group_key: 'k1', sources: [src('https://a.example/1')] })]),
    node('financials', [fact({ section: 'financials', group_key: 'k2', sources: [src('https://b.example/2')] })]),
    // Carries k1 (matches the first) AND b.example/2 (matches the second).
    node('risk_flags', [
      fact({ section: 'risk_flags', group_key: 'k1', importance: 9, sources: [src('https://b.example/2'), src('https://c.example/3')] }),
    ]),
  ]);
  assert.equal(facts.length, 1, 'the bridging fact must collapse both groups, not just one');
  assert.equal(facts[0].sources.length, 3, 'every distinct source survives the fold');
  assert.equal(facts[0].importance, 9, 'max importance survives across a transitive fold');
  assert.equal(facts[0].section, 'news', 'the earliest-seen fact still owns the text/section');
});

test('merge: distinct stories are left alone', () => {
  const { facts, mergedCount } = mergeTopicFacts([
    node('news', [fact({ group_key: 'acme-launch', sources: [src('https://a.example/1')] })]),
    node('risk_flags', [fact({ section: 'risk_flags', group_key: 'acme-lawsuit', sources: [src('https://b.example/2')] })]),
  ]);
  assert.equal(facts.length, 2);
  assert.equal(mergedCount, 0);
});

// A null group_key means "nothing to group with" — two of them must never be
// treated as a matching pair.
test('merge: null group_keys do not collide with each other', () => {
  const { facts } = mergeTopicFacts([
    node('news', [fact({ group_key: null, sources: [src('https://a.example/1')] })]),
    node('news', [fact({ group_key: null, sources: [src('https://b.example/2')] })]),
  ]);
  assert.equal(facts.length, 2, 'null is not an identity');
});

test('merge: a fact citing one URL twice keeps a single source row', () => {
  const { facts } = mergeTopicFacts([
    node('news', [fact({ sources: [src('https://a.example/1'), src('https://www.a.example/1/')] })]),
  ]);
  assert.equal(facts[0].sources.length, 1, 'www./trailing-slash variants are the same URL');
});

test('merge: null fact_date and stats are filled in from the merged-in fact', () => {
  const { facts } = mergeTopicFacts([
    node('news', [fact({ group_key: 'k', fact_date: null, stats: null, sources: [src('https://a.example/1')] })]),
    node('financials', [fact({ section: 'financials', group_key: 'k', fact_date: '2026-06-01', stats: { amount_raised: '$50M' }, sources: [src('https://b.example/2')] })]),
  ]);
  assert.equal(facts[0].fact_date, '2026-06-01');
  assert.deepEqual(facts[0].stats, { amount_raised: '$50M' });
});

// The incremental-enrichment rule, applied after the merge: a story already on
// file under one URL stays a repeat even when another section finds fresh
// coverage of it under a new URL.
test('merge: known_urls drops a merged fact even when only one of its URLs is known', () => {
  const known = new Set([normalizeUrl('https://tc.example/story')]);
  const { facts, droppedKnown } = mergeTopicFacts(
    [
      node('news', [fact({ group_key: 'k', sources: [src('https://tc.example/story')] })]),
      node('financials', [fact({ section: 'financials', group_key: 'k', sources: [src('https://brand-new.example/x')] })]),
    ],
    known
  );
  assert.equal(facts.length, 0, 'a known URL anywhere in the merged group drops it');
  assert.equal(droppedKnown, 1);
});

test('merge: an empty or failed topic node contributes nothing and does not throw', () => {
  const { facts } = mergeTopicFacts([node('news', []), null, undefined, node('financials', [fact()])]);
  assert.equal(facts.length, 1);
});

test('verify gate targets only risky facts', () => {
  const now = new Date('2026-07-23T00:00:00Z');
  const twoSources = [src('https://a.example/1'), src('https://b.example/2')];

  assert.equal(riskyReason(fact({ sources: [src('https://a.example/1')] }), { now }), 'single-source');
  assert.equal(
    riskyReason(fact({ section: 'financials', sources: twoSources }), { companyType: 'private', now }),
    'private-company financial estimate'
  );
  assert.equal(
    riskyReason(fact({ text: 'Rumored to be exploring a sale.', sources: twoSources }), { now }),
    'rumor-labeled'
  );
  // news window is 6 months: cutoff 2026-01-23, so a 2026-01-30 fact sits
  // inside the 14-day edge band where a small date error flips inclusion.
  assert.equal(
    riskyReason(fact({ fact_date: '2026-01-30', sources: twoSources }), { now }),
    'fact_date near the edge of the section window'
  );
  // Well-sourced, recent, public, not a rumor — no skeptic call, no cost.
  assert.equal(riskyReason(fact({ sources: twoSources }), { companyType: 'public', now }), null);
});
