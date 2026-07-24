// Pure rollup over the per-job cost objects the runner writes to
// enrichment_jobs.cost. Kept out of scripts/costs.mjs so the arithmetic — the
// part that can be quietly wrong — is testable without a network round trip,
// same split as lib/topic-graph.mjs.

// Groups every node across every job by stage name.
//
// Ranking is by TOTAL spend, not average: a stage can be cheap per run and
// still dominate the bill because it runs on every job, and that is the one
// worth attention. `usd: null` marks a call that died before reporting — it is
// counted as a run and as a failure, but contributes 0 to the total, so the
// figure is honestly a floor rather than a guess.
export function rollupCosts(jobs) {
  const total = jobs.reduce((sum, job) => sum + (job.cost?.usd ?? 0), 0);
  const byNode = new Map();

  for (const job of jobs) {
    for (const node of job.cost?.nodes ?? []) {
      const acc = byNode.get(node.node) ?? {
        node: node.node,
        runs: 0,
        usd: 0,
        web: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ms: 0,
        failures: 0,
      };
      acc.runs += 1;
      acc.usd += node.usd ?? 0;
      acc.web += node.web ?? 0;
      acc.cacheRead += node.cache_read ?? 0;
      acc.cacheWrite += node.cache_write ?? 0;
      acc.ms += node.ms ?? 0;
      if (node.usd === null || node.usd === undefined) acc.failures += 1;
      byNode.set(node.node, acc);
    }
  }

  const stages = [...byNode.values()]
    .map((a) => ({
      ...a,
      avgUsd: a.usd / a.runs,
      avgWeb: a.web / a.runs,
      avgSeconds: a.ms / a.runs / 1000,
      // Share of the whole bill. Guard the empty case so a report over jobs
      // that all failed prints 0% instead of NaN.
      share: total === 0 ? 0 : a.usd / total,
      // Reads bill roughly 10x cheaper than writes, so a ratio well under 1
      // means this stage rebuilds its prompt prefix every run instead of
      // reusing it — usually the cheapest thing to fix. null = never wrote a
      // cache entry, which is not the same as a bad ratio.
      cacheRatio: a.cacheWrite === 0 ? null : a.cacheRead / a.cacheWrite,
    }))
    .sort((a, b) => b.usd - a.usd);

  return { total, stages };
}
