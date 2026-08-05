// Pure deck-spec assembly helpers — the CODE edge between approved market
// facts and the .pptx (spec §7.2: "no model call touches a number"). Same
// zero-I/O style as topic-graph.test.mjs: hand-built fact fixtures, no DB, no
// claude, no python.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarketSizeChart,
  buildMarketShareChart,
  buildDealTimelineTokens,
  buildVocabTokens,
} from '../lib/market-deck.mjs';

const fact = (over = {}) => ({
  section: 'market_size',
  text: 'A thing happened.',
  fact_date: '2026-01-01',
  group_key: null,
  importance: 5,
  stats: null,
  sources: [],
  ...over,
});

const CATEGORIES = ['Hospital-Affiliated ASCs', 'Physician-Owned ASCs', 'Corporate-Chain ASCs'];

// ---------------------------------------------------------------- buildMarketSizeChart

test('market size chart: a category with 2+ cited years becomes a series', () => {
  const facts = [
    fact({ stats: { type: 'tam', value: 18.2, unit: 'USD_B', year: 2024, geography: 'US', segment: CATEGORIES[0] } }),
    fact({ stats: { type: 'tam', value: 19.1, unit: 'USD_B', year: 2025, geography: 'US', segment: CATEGORIES[0] } }),
  ];
  const chart = buildMarketSizeChart(facts, CATEGORIES);
  assert.deepEqual(chart.years, [2024, 2025]);
  assert.deepEqual(chart.series, { CATEGORY_1_NAME: [18.2, 19.1] });
});

test('market size chart: a category with only 1 cited year is omitted, not padded', () => {
  const facts = [
    fact({ stats: { type: 'tam', value: 18.2, unit: 'USD_B', year: 2024, geography: 'US', segment: CATEGORIES[0] } }),
  ];
  const chart = buildMarketSizeChart(facts, CATEGORIES);
  assert.deepEqual(chart, { years: [], series: {} }, 'a single point is thin, never interpolated into a line');
});

test('market size chart: three categories with the same cited years match the skeleton shape exactly', () => {
  const facts = CATEGORIES.flatMap((segment, i) => [
    fact({ stats: { type: 'tam', value: 10 + i, unit: 'USD_B', year: 2024, geography: 'US', segment } }),
    fact({ stats: { type: 'tam', value: 11 + i, unit: 'USD_B', year: 2025, geography: 'US', segment } }),
  ]);
  const chart = buildMarketSizeChart(facts, CATEGORIES);
  assert.deepEqual(chart.years, [2024, 2025]);
  assert.deepEqual(Object.keys(chart.series), ['CATEGORY_1_NAME', 'CATEGORY_2_NAME', 'CATEGORY_3_NAME']);
  assert.deepEqual(chart.series.CATEGORY_2_NAME, [11, 12]);
});

test('market size chart: a segment that matches none of the 3 categories contributes no series', () => {
  const facts = [
    fact({ stats: { type: 'tam', value: 40, unit: 'USD_B', year: 2024, geography: 'US', segment: null } }),
    fact({ stats: { type: 'tam', value: 41, unit: 'USD_B', year: 2025, geography: 'US', segment: 'Some Other Rollup' } }),
  ];
  assert.deepEqual(buildMarketSizeChart(facts, CATEGORIES), { years: [], series: {} });
});

test('market size chart: non-tam facts and a fact with no stats are ignored', () => {
  const facts = [
    fact({ stats: { type: 'share', player: 'Acme', share_pct: 20, year: 2024 } }),
    fact({ stats: null }),
  ];
  assert.deepEqual(buildMarketSizeChart(facts, CATEGORIES), { years: [], series: {} });
});

test('market size chart: a duplicate year for one category keeps the first-cited value', () => {
  const facts = [
    fact({ stats: { type: 'tam', value: 18.2, unit: 'USD_B', year: 2024, geography: 'US', segment: CATEGORIES[0] } }),
    fact({ stats: { type: 'tam', value: 99, unit: 'USD_B', year: 2024, geography: 'US', segment: CATEGORIES[0] } }),
    fact({ stats: { type: 'tam', value: 19.1, unit: 'USD_B', year: 2025, geography: 'US', segment: CATEGORIES[0] } }),
  ];
  const chart = buildMarketSizeChart(facts, CATEGORIES);
  assert.deepEqual(chart.series.CATEGORY_1_NAME, [18.2, 19.1], 'the first cited estimate for a year wins, not the last');
});

test('market size chart: no facts at all returns the empty shape', () => {
  assert.deepEqual(buildMarketSizeChart([], CATEGORIES), { years: [], series: {} });
  assert.deepEqual(buildMarketSizeChart(undefined, CATEGORIES), { years: [], series: {} });
});

// ---------------------------------------------------------------- buildMarketShareChart

test('market share chart: fewer than 2 named players returns null (no invented split)', () => {
  assert.equal(buildMarketShareChart([]), null);
  assert.equal(
    buildMarketShareChart([fact({ stats: { type: 'share', player: 'Acme', share_pct: 20, year: 2024 } })]),
    null
  );
});

test('market share chart: top 4 players by share plus an OTHER residual', () => {
  const facts = [
    fact({ stats: { type: 'share', player: 'A', share_pct: 18, year: 2024 } }),
    fact({ stats: { type: 'share', player: 'B', share_pct: 15, year: 2024 } }),
    fact({ stats: { type: 'share', player: 'C', share_pct: 8, year: 2024 } }),
    fact({ stats: { type: 'share', player: 'D', share_pct: 4, year: 2024 } }),
    fact({ stats: { type: 'share', player: 'E', share_pct: 2, year: 2024 } }), // 5th player, folds into OTHER
  ];
  assert.deepEqual(buildMarketShareChart(facts), { P1: 18, P2: 15, P3: 8, P4: 4, OTHER: 55 });
});

test('market share chart: only 2 named players yields just P1/P2, no invented P3/P4', () => {
  const facts = [
    fact({ stats: { type: 'share', player: 'A', share_pct: 30, year: 2024 } }),
    fact({ stats: { type: 'share', player: 'B', share_pct: 20, year: 2024 } }),
  ];
  assert.deepEqual(buildMarketShareChart(facts), { P1: 30, P2: 20, OTHER: 50 });
});

test('market share chart: a repeated player keeps its first-cited share_pct', () => {
  const facts = [
    fact({ stats: { type: 'share', player: 'A', share_pct: 30, year: 2024 } }),
    fact({ stats: { type: 'share', player: 'A', share_pct: 99, year: 2025 } }),
    fact({ stats: { type: 'share', player: 'B', share_pct: 20, year: 2024 } }),
  ];
  assert.deepEqual(buildMarketShareChart(facts), { P1: 30, P2: 20, OTHER: 50 });
});

// ---------------------------------------------------------------- buildDealTimelineTokens

test('deal timeline: acquisitions are sorted by date and indexed from 1', () => {
  const facts = [
    fact({ section: 'deals', stats: { type: 'acquisition', acquirer: 'HCA', target: 'MD Now', announced: '2022-09-01' } }),
    fact({ section: 'deals', stats: { type: 'acquisition', acquirer: 'Tenet', target: 'SurgCenter Dev', announced: '2021-12-01' } }),
  ];
  const tokens = buildDealTimelineTokens(facts, { now: new Date('2026-06-01') });
  assert.equal(tokens.ACQUISITION_1_ACQUIRER, 'Tenet');
  assert.equal(tokens.ACQUISITION_1_TARGET, 'SurgCenter Dev');
  assert.equal(tokens.DATE_1, 'Dec 2021');
  assert.equal(tokens.ACQUISITION_2_ACQUIRER, 'HCA');
  assert.equal(tokens.DATE_2, 'Sep 2022');
});

test('deal timeline: caps at 10 deals, keeping the 10 earliest', () => {
  const facts = Array.from({ length: 12 }, (_, i) =>
    fact({
      section: 'deals',
      stats: { type: 'acquisition', acquirer: `Acquirer${i}`, target: `Target${i}`, announced: `2020-${String((i % 12) + 1).padStart(2, '0')}-01` },
    })
  );
  const tokens = buildDealTimelineTokens(facts, { now: new Date('2026-06-01') });
  assert.equal(Object.keys(tokens).filter((k) => k.startsWith('ACQUISITION_')).length, 20, '10 deals x 2 keys each');
  assert.equal(tokens.ACQUISITION_11_ACQUIRER, undefined, 'never more than 10 deal slots');
});

test('deal timeline: a malformed acquisition fact (missing a required field) is skipped, not slotted', () => {
  const facts = [
    fact({ section: 'deals', stats: { type: 'acquisition', acquirer: 'HCA', target: null, announced: '2022-09-01' } }),
    fact({ section: 'deals', stats: { type: 'acquisition', acquirer: 'Tenet', target: 'SurgCenter Dev', announced: '2021-12-01' } }),
  ];
  const tokens = buildDealTimelineTokens(facts, { now: new Date('2026-06-01') });
  assert.equal(tokens.ACQUISITION_1_ACQUIRER, 'Tenet', 'the malformed fact does not consume a slot');
  assert.equal(tokens.ACQUISITION_2_ACQUIRER, undefined);
});

test('deal timeline: non-acquisition and null-stats facts are ignored', () => {
  const facts = [
    fact({ stats: { type: 'funding', company: 'Acme', amount: '$5M', round: 'Seed', lead_investors: [] } }),
    fact({ stats: null }),
  ];
  const tokens = buildDealTimelineTokens(facts, { now: new Date('2026-06-01') });
  assert.equal(Object.keys(tokens).some((k) => k.startsWith('ACQUISITION_')), false);
});

test('deal timeline: YEAR_1..YEAR_7 is the trailing 7-year window ending at the given "now"', () => {
  const tokens = buildDealTimelineTokens([], { now: new Date('2026-06-01') });
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((i) => tokens[`YEAR_${i}`]),
    ['2020', '2021', '2022', '2023', '2024', '2025', '2026']
  );
});

// ---------------------------------------------------------------- buildVocabTokens

test('vocab tokens: straight mapping off the markets row', () => {
  const marketRow = {
    name: 'Ambulatory Surgery Centers',
    geography: 'US',
    categories: ['Hospital-Affiliated ASCs', 'Physician-Owned ASCs', 'Corporate-Chain ASCs'],
    customer_org_type: 'the surgery center',
  };
  assert.deepEqual(buildVocabTokens(marketRow), {
    MARKET_NAME: 'Ambulatory Surgery Centers',
    GEOGRAPHY: 'US',
    CUSTOMER_ORG_TYPE: 'the surgery center',
    CATEGORY_1_NAME: 'Hospital-Affiliated ASCs',
    CATEGORY_2_NAME: 'Physician-Owned ASCs',
    CATEGORY_3_NAME: 'Corporate-Chain ASCs',
  });
});

test('vocab tokens: a wrong/missing field blanks rather than throws, and short categories omit the missing slot', () => {
  const tokens = buildVocabTokens({ name: 'Widgets', geography: null, categories: ['Only One'], customer_org_type: undefined });
  assert.equal(tokens.MARKET_NAME, 'Widgets');
  assert.equal(tokens.GEOGRAPHY, '');
  assert.equal(tokens.CUSTOMER_ORG_TYPE, '');
  assert.equal(tokens.CATEGORY_1_NAME, 'Only One');
  assert.equal('CATEGORY_2_NAME' in tokens, false, 'no invented second category');
});

test('vocab tokens: a null marketRow does not throw', () => {
  const tokens = buildVocabTokens(null);
  assert.equal(tokens.MARKET_NAME, '');
});
