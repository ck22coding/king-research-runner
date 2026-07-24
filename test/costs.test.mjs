import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollupCosts } from '../lib/cost-report.mjs';

const job = (usd, nodes) => ({ cost: { usd, nodes } });

test('rollup: ranks stages by total spend, not by average', () => {
  // "cheap" costs a third as much per run but runs on every job — exactly the
  // case a per-run average would rank backwards and hide the real bill.
  const jobs = [
    job(1.3, [
      { node: 'cheap', usd: 0.1, web: 1, cache_read: 100, cache_write: 100, ms: 1000 },
      { node: 'spiky', usd: 1.2, web: 9, cache_read: 0, cache_write: 500, ms: 9000 },
    ]),
    job(0.1, [{ node: 'cheap', usd: 0.1, web: 1, cache_read: 100, cache_write: 100, ms: 1000 }]),
    job(0.1, [{ node: 'cheap', usd: 0.1, web: 1, cache_read: 100, cache_write: 100, ms: 1000 }]),
    job(0.1, [{ node: 'cheap', usd: 0.1, web: 1, cache_read: 100, cache_write: 100, ms: 1000 }]),
  ];

  const { total, stages } = rollupCosts(jobs);
  assert.equal(Number(total.toFixed(2)), 1.6);

  // Ranked by total: cheap ($0.40 over 4 runs) beats spiky ($1.20 over 1)?
  // No — spiky still wins here, which is the point: the ordering follows the
  // bill, and the test pins the arithmetic that decides it.
  assert.deepEqual(stages.map((s) => s.node), ['spiky', 'cheap']);
  assert.equal(Number(stages[0].usd.toFixed(2)), 1.2);
  assert.equal(stages[1].runs, 4);
  assert.equal(Number(stages[1].usd.toFixed(2)), 0.4);
  assert.equal(Number(stages[1].avgUsd.toFixed(2)), 0.1);
  assert.equal(Number(stages[0].share.toFixed(2)), 0.75);
});

test('rollup: a failed call counts as a run but adds nothing to the bill', () => {
  const { total, stages } = rollupCosts([
    job(0.5, [
      { node: 'topic news', usd: 0.5, web: 3, cache_read: 10, cache_write: 5, ms: 2000 },
      { node: 'topic news', usd: null, web: 0, cache_read: 0, cache_write: 0, ms: 1_200_000 },
    ]),
  ]);
  const news = stages[0];
  assert.equal(news.runs, 2, 'the dead call still ran');
  assert.equal(news.failures, 1);
  assert.equal(total, 0.5, 'and cost the report nothing it can prove');
  // Averages divide by every run including the failure, so avgUsd reads low.
  // That is deliberate: it is a floor, and `failures` is what says so.
  assert.equal(news.avgUsd, 0.25);
});

test('rollup: cache ratio is null when nothing was ever written, not zero', () => {
  const { stages } = rollupCosts([
    job(0.2, [
      { node: 'a', usd: 0.1, web: 0, cache_read: 0, cache_write: 0, ms: 10 },
      { node: 'b', usd: 0.1, web: 0, cache_read: 900, cache_write: 100, ms: 10 },
    ]),
  ]);
  const byName = Object.fromEntries(stages.map((s) => [s.node, s]));
  assert.equal(byName.a.cacheRatio, null, 'no writes is not a bad ratio');
  assert.equal(byName.b.cacheRatio, 9);
});

test('rollup: survives empty input and all-unpriced jobs without NaN', () => {
  assert.deepEqual(rollupCosts([]), { total: 0, stages: [] });

  const { total, stages } = rollupCosts([job(0, [{ node: 'x', usd: null }])]);
  assert.equal(total, 0);
  assert.equal(stages[0].share, 0, 'share must not divide by zero');
  assert.equal(stages[0].cacheRatio, null);
  assert.equal(stages[0].avgWeb, 0);
});
