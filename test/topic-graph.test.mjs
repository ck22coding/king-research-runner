// The merge edge is the one piece of the diamond with no model in the loop
// and no DB behind it — pure logic, so it gets a pure test. No Supabase, no
// fake claude, no network: runs in milliseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTopicFacts, riskyReason, normalizeUrl } from '../lib/topic-graph.mjs';

const src = (url, publisher = 'Test Wire') => ({ publisher, title: null, url, year: 2026 });
const fact = (over = {}) => ({
  section: 'growth_signals',
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
    node('growth_signals', [fact({ section: 'growth_signals', group_key: 'acme-series-c', importance: 4, sources: [src('https://wsj.example/b')] })]),
  ]);
  assert.equal(facts.length, 1, 'expected one merged fact');
  assert.equal(mergedCount, 1);
  assert.equal(facts[0].section, 'financials', 'first-seen section wins');
  assert.equal(facts[0].sources.length, 2, 'sources unioned across sections');
  assert.equal(facts[0].importance, 9, 'importance takes the max, not the last');
});

// The edge the spec calls out: independently-run sections slug the same story
// differently, so group_key alone misses it and URL overlap has to catch it.
// This is the common shape — one side has no group_key ("nothing else to group
// it with", per SKILL.md step 7).
test('merge: an overlapping source URL collapses facts when neither names a rival story', () => {
  const { facts } = mergeTopicFacts([
    node('growth_signals', [fact({ group_key: null, sources: [src('https://tc.example/story')] })]),
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
  assert.equal(facts[0].group_key, 'acme-series-c', 'the non-null group_key fills in the null one');
});

// The guard (Carter, 2026-07-23). Two sections citing one document for two
// DIFFERENT claims — an annual report supporting both a financials and a risk
// flag — must not collapse, or the second claim is silently lost. Each side
// named its own story, so believe them.
test('merge: a shared URL does NOT merge facts that named different stories', () => {
  const annualReport = src('https://acme.example/2026-annual-report');
  const { facts } = mergeTopicFacts([
    node('financials', [
      fact({ section: 'financials', group_key: 'acme-fy26-revenue', text: 'Revenue grew 12%.', sources: [annualReport, src('https://a.example/1')] }),
    ]),
    node('risk_flags', [
      fact({ section: 'risk_flags', group_key: 'acme-supplier-concentration', text: 'One supplier accounts for 40% of components.', sources: [annualReport, src('https://b.example/2')] }),
    ]),
  ]);
  assert.equal(facts.length, 2, 'two distinct claims citing one document must both survive');
  assert.deepEqual(
    facts.map((f) => f.section).sort(),
    ['financials', 'risk_flags'],
    'neither section is swallowed by the other'
  );
});

// Grouping has to be transitive (codex review): the third fact is the only
// thing connecting the first two, and picking a single match would leave the
// story split across two facts — the exact duplicate this edge removes.
test('merge: a fact bridging two existing groups collapses all three', () => {
  const { facts } = mergeTopicFacts([
    node('growth_signals', [fact({ group_key: 'k1', sources: [src('https://a.example/1')] })]),
    // No group_key, so the URL guard lets it join something later.
    node('financials', [fact({ section: 'financials', group_key: null, sources: [src('https://b.example/2')] })]),
    // Carries k1 (matches the first) AND b.example/2 (matches the second).
    node('risk_flags', [
      fact({ section: 'risk_flags', group_key: 'k1', importance: 9, sources: [src('https://b.example/2'), src('https://c.example/3')] }),
    ]),
  ]);
  assert.equal(facts.length, 1, 'the bridging fact must collapse both groups, not just one');
  assert.equal(facts[0].sources.length, 3, 'every distinct source survives the fold');
  assert.equal(facts[0].importance, 9, 'max importance survives across a transitive fold');
  assert.equal(facts[0].section, 'growth_signals', 'the earliest-seen fact still owns the text/section');
});

test('merge: distinct stories are left alone', () => {
  const { facts, mergedCount } = mergeTopicFacts([
    node('growth_signals', [fact({ group_key: 'acme-launch', sources: [src('https://a.example/1')] })]),
    node('risk_flags', [fact({ section: 'risk_flags', group_key: 'acme-lawsuit', sources: [src('https://b.example/2')] })]),
  ]);
  assert.equal(facts.length, 2);
  assert.equal(mergedCount, 0);
});

// A null group_key means "nothing to group with" — two of them must never be
// treated as a matching pair.
test('merge: null group_keys do not collide with each other', () => {
  const { facts } = mergeTopicFacts([
    node('growth_signals', [fact({ group_key: null, sources: [src('https://a.example/1')] })]),
    node('growth_signals', [fact({ group_key: null, sources: [src('https://b.example/2')] })]),
  ]);
  assert.equal(facts.length, 2, 'null is not an identity');
});

test('merge: a fact citing one URL twice keeps a single source row', () => {
  const { facts } = mergeTopicFacts([
    node('growth_signals', [fact({ sources: [src('https://a.example/1'), src('https://www.a.example/1/')] })]),
  ]);
  assert.equal(facts[0].sources.length, 1, 'www./trailing-slash variants are the same URL');
});

test('merge: null fact_date and stats are filled in from the merged-in fact', () => {
  const { facts } = mergeTopicFacts([
    node('growth_signals', [fact({ group_key: 'k', fact_date: null, stats: null, sources: [src('https://a.example/1')] })]),
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
      node('growth_signals', [fact({ group_key: 'k', sources: [src('https://tc.example/story')] })]),
      node('financials', [fact({ section: 'financials', group_key: 'k', sources: [src('https://brand-new.example/x')] })]),
    ],
    known
  );
  assert.equal(facts.length, 0, 'a known URL anywhere in the merged group drops it');
  assert.equal(droppedKnown, 1);
});

test('merge: an empty or failed topic node contributes nothing and does not throw', () => {
  const { facts } = mergeTopicFacts([node('growth_signals', []), null, undefined, node('financials', [fact()])]);
  assert.equal(facts.length, 1);
});

// The market guard (spec §5). market-jumpstart deliberately gives
// conflicting TAM/CAGR/etc. estimates the SAME group_key on purpose, so the
// deck can render them side by side (CHECKLIST.md §2) instead of losing one
// silently to the merge the shared group_key would otherwise trigger.
test('merge: a shared group_key does NOT merge two facts whose stats disagree on the same quantity', () => {
  const { facts, mergedCount } = mergeTopicFacts([
    node('market_size', [
      fact({
        section: 'market_size',
        group_key: 'tam-us-2026',
        text: 'TAM is $4.2B, per Grand View Research.',
        sources: [src('https://grandview.example/report')],
        stats: { type: 'tam', value: 4.2, unit: 'USD_B', year: 2026, geography: 'US', segment: null },
      }),
    ]),
    node('market_size', [
      fact({
        section: 'market_size',
        group_key: 'tam-us-2026',
        text: 'TAM is $6.8B, per IDC.',
        sources: [src('https://idc.example/report')],
        stats: { type: 'tam', value: 6.8, unit: 'USD_B', year: 2026, geography: 'US', segment: null },
      }),
    ]),
  ]);
  assert.equal(facts.length, 2, 'disagreeing estimates must both survive, unmerged');
  assert.equal(mergedCount, 0);
});

test('merge: a shared group_key still merges when both sides\' stats agree', () => {
  const { facts, mergedCount } = mergeTopicFacts([
    node('market_size', [
      fact({
        section: 'market_size',
        group_key: 'tam-us-2026',
        sources: [src('https://grandview.example/report')],
        stats: { type: 'tam', value: 4.2, unit: 'USD_B', year: 2026, geography: 'US', segment: null },
      }),
    ]),
    node('market_size', [
      fact({
        section: 'market_size',
        group_key: 'tam-us-2026',
        sources: [src('https://another.example/report')],
        stats: { type: 'tam', value: 4.2, unit: 'USD_B', year: 2026, geography: 'US', segment: null },
      }),
    ]),
  ]);
  assert.equal(facts.length, 1, 'agreeing stats under the same group_key still merge as before');
  assert.equal(mergedCount, 1);
  assert.equal(facts[0].sources.length, 2);
});

test('merge: facts with stats:null are unaffected by the market guard (company behavior unchanged)', () => {
  const { facts, mergedCount } = mergeTopicFacts([
    node('financials', [fact({ section: 'financials', group_key: 'acme-series-c', sources: [src('https://tc.example/a')] })]),
    node('growth_signals', [fact({ section: 'growth_signals', group_key: 'acme-series-c', sources: [src('https://wsj.example/b')] })]),
  ]);
  assert.equal(facts.length, 1, 'null-stats facts still merge on a shared group_key');
  assert.equal(mergedCount, 1);
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
  // growth_signals window is 6 months: cutoff 2026-01-23, so a 2026-01-30 fact sits
  // inside the 14-day edge band where a small date error flips inclusion.
  assert.equal(
    riskyReason(fact({ fact_date: '2026-01-30', sources: twoSources }), { now }),
    'fact_date near the edge of the section window'
  );
  // Well-sourced, recent, public, not a rumor — no skeptic call, no cost.
  assert.equal(riskyReason(fact({ sources: twoSources }), { companyType: 'public', now }), null);
});

// The market branch (spec §6.2). Company behavior above is untouched; these
// only trigger on market stats.type shapes.
test('verify gate: market branch — a single-source numeric fact is still "single-source"', () => {
  const twoSources = [src('https://a.example/1'), src('https://b.example/2')];
  assert.equal(
    riskyReason(fact({ section: 'market_size', sources: [src('https://a.example/1')], stats: { type: 'tam', value: 4.2, year: 2026 } })),
    'single-source'
  );
  // sanity: the same fact well-sourced and non-share is not flagged by the
  // market branch at all.
  assert.equal(
    riskyReason(fact({ section: 'market_size', sources: twoSources, stats: { type: 'tam', value: 4.2, year: 2026 }, text: 'TAM is $4.2B.' })),
    null
  );
});

test('verify gate: market branch — every share fact is flagged regardless of source count', () => {
  const twoSources = [src('https://a.example/1'), src('https://b.example/2')];
  const reason = riskyReason(
    fact({ section: 'vendors', sources: twoSources, stats: { type: 'share', player: 'Acme', share_pct: 12, year: 2026 }, text: 'Acme holds 12% share.' })
  );
  assert.ok(reason, 'a two-source share fact must still be flagged');
  assert.notEqual(reason, null);
});

test('verify gate: market branch — a text number absent from stats is flagged', () => {
  const twoSources = [src('https://a.example/1'), src('https://b.example/2')];
  const reason = riskyReason(
    fact({
      section: 'market_size',
      sources: twoSources,
      text: 'The market grew 22% last year.',
      stats: { type: 'cagr', rate_pct: 18, window_start: 2025, window_end: 2026 },
    })
  );
  assert.ok(reason, 'a number in the text that stats does not state must be flagged');
  // sanity: when every number in the text is also in stats, no flag.
  assert.equal(
    riskyReason(
      fact({
        section: 'market_size',
        sources: twoSources,
        text: 'Growing at 18% CAGR from 2025 to 2026.',
        stats: { type: 'cagr', rate_pct: 18, window_start: 2025, window_end: 2026 },
      })
    ),
    null
  );
});
