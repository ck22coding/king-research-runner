#!/usr/bin/env node
// Read-only cost report over enrichment_jobs.cost.
//
// Deliberately a script and not a UI: the question "which stage should I
// optimise" gets asked occasionally and answered by reading a table, which is
// a worse fit for a dashboard than for a command. It is also the thing Claude
// runs when Carter asks about spend, so the output is shaped to be read by
// either of us.
//
//   node scripts/costs.mjs                 # last 30 days
//   node scripts/costs.mjs --days 7
//   node scripts/costs.mjs --json          # raw, for further analysis
//
// Needs SUPABASE_SERVICE_ROLE_KEY (bypasses RLS so it sees every user's jobs).
// Point KR_ENV_FILE at the env file holding it:
//   KR_ENV_FILE=~/Projects/dad/.env node scripts/costs.mjs
//
// ponytail: plain fetch against PostgREST, no supabase-js and no psql. The
// per-stage rollup happens in JS because the nodes live in a jsonb array and
// PostgREST cannot aggregate across jsonb_array_elements — Postgres can (see
// the SQL in README.md), this just avoids needing a psql client at all. The
// arithmetic lives in lib/cost-report.mjs so it can be tested offline.
import { rollupCosts } from '../lib/cost-report.mjs';

try {
  process.loadEnvFile(process.env.KR_ENV_FILE ?? '.env');
} catch {}

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) {
  console.error(
    'FATAL: need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Try: KR_ENV_FILE=~/Projects/dad/.env node scripts/costs.mjs'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const daysArg = args.indexOf('--days');
const days = daysArg === -1 ? 30 : Number(args[daysArg + 1]) || 30;
const since = new Date(Date.now() - days * 86_400_000).toISOString();

// cost=not.is.null skips both pre-migration rows and jobs that died before any
// claude call reported — neither is a zero-cost run, and averaging them in as
// zero would quietly understate every stage.
const query =
  `enrichment_jobs?select=id,kind,status,created_at,cost,companies(name)` +
  `&cost=not.is.null&created_at=gte.${since}&order=created_at.desc`;

const res = await fetch(`${URL_BASE}/rest/v1/${query}`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
if (!res.ok) {
  console.error(`FATAL: query failed (HTTP ${res.status}): ${await res.text()}`);
  process.exit(1);
}
const jobs = await res.json();

if (asJson) {
  console.log(JSON.stringify(jobs, null, 2));
  process.exit(0);
}

if (jobs.length === 0) {
  console.log(
    `No jobs with recorded cost in the last ${days} days.\n` +
      'Cost is recorded from the first job run after the telemetry change — ' +
      'older jobs have cost = null and are excluded rather than counted as $0.'
  );
  process.exit(0);
}

const usd = (n) => (n === null || n === undefined ? '—' : `$${n.toFixed(3)}`);
const { total, stages } = rollupCosts(jobs);

console.log(`\n=== ${jobs.length} jobs, last ${days} days — $${total.toFixed(2)} total ===\n`);

console.log('STAGE                 RUNS   TOTAL$    AVG$  SHARE   AVG WEB   CACHE r:w   AVG s  FAILED');
for (const s of stages) {
  console.log(
    `${s.node.padEnd(20)} ${String(s.runs).padStart(5)} ` +
      `${s.usd.toFixed(2).padStart(8)} ${s.avgUsd.toFixed(3).padStart(7)} ` +
      `${(s.share * 100).toFixed(0).padStart(5)}% ` +
      `${s.avgWeb.toFixed(1).padStart(9)} ` +
      `${(s.cacheRatio === null ? '—' : s.cacheRatio.toFixed(1)).padStart(11)} ` +
      `${Math.round(s.avgSeconds).toString().padStart(6)} ` +
      `${String(s.failures).padStart(7)}`
  );
}

console.log('\n=== recent jobs ===');
for (const job of jobs.slice(0, 15)) {
  const name = job.companies?.name ?? job.id.slice(0, 8);
  const unpriced = job.cost?.unpriced ? `  (${job.cost.unpriced} unpriced)` : '';
  console.log(
    `${job.created_at.slice(0, 16).replace('T', ' ')}  ${usd(job.cost?.usd).padStart(9)}  ` +
      `${(job.kind ?? 'enrich').padEnd(8)} ${job.status.padEnd(7)} ${name}${unpriced}`
  );
}
console.log();
