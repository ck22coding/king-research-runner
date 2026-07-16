#!/usr/bin/env node
// Local enrichment runner: polls Supabase for queued enrichment_jobs, claims
// one at a time, invokes the company-preview claude -p skill, and writes
// suggested facts/sources back to the DB.
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Same plugin tree test-run.sh drives — see that script for the exact
// claude -p contract this runner replicates.
const PLUGIN_DIR = '/Users/carterking/Projects/dad/company-preview/skill/plugins/company-preview';
const SCHEMA_PATH = path.join(PLUGIN_DIR, 'references', 'output-schema.json');

// Root .env is read in place — never copied alongside this repo. It holds
// the runner's credentials and the Supabase project config.
const ENV_PATH = '/Users/carterking/Projects/dad/.env';
try {
  process.loadEnvFile(ENV_PATH);
} catch (err) {
  console.error(
    `FATAL: could not read env file at ${ENV_PATH} (${err.message}). ` +
      'This file is read in place from the dad/ project root — it is never copied into runner/.'
  );
  process.exit(1);
}

const REQUIRED_ENV = [
  'RUNNER_EMAIL',
  'RUNNER_PASSWORD',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`FATAL: missing required env var(s) in ${ENV_PATH}: ${missing.join(', ')}`);
  process.exit(1);
}

const { RUNNER_EMAIL, RUNNER_PASSWORD, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } =
  process.env;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5000;

let CLAUDE_BIN;
try {
  CLAUDE_BIN = (process.env.CLAUDE_BIN || execSync('command -v claude').toString()).trim();
  if (!CLAUDE_BIN) throw new Error('command -v claude returned nothing');
} catch (err) {
  console.error(
    'FATAL: could not resolve the claude binary. Set CLAUDE_BIN to its absolute path. ' +
      'Daemon/background contexts (e.g. this runner started from a launchd job or another ' +
      "non-interactive parent) don't inherit your interactive shell's PATH, so " +
      `\`command -v claude\` can fail here even though \`claude\` works fine in your terminal. (${err.message})`
  );
  process.exit(1);
}

const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { error: signInError } = await supabase.auth.signInWithPassword({
  email: RUNNER_EMAIL,
  password: RUNNER_PASSWORD,
});
if (signInError) {
  console.error(`FATAL: sign-in failed for ${RUNNER_EMAIL}: ${signInError.message}`);
  process.exit(1);
}

console.log(`runner started: signed in as ${RUNNER_EMAIL}, claude binary resolved to ${CLAUDE_BIN}`);

let schemaText;
try {
  schemaText = readFileSync(SCHEMA_PATH, 'utf8');
} catch (err) {
  console.error(`FATAL: could not read output schema at ${SCHEMA_PATH} (${err.message})`);
  process.exit(1);
}

// ponytail: single-runner ceiling. A job found 'running' at boot can only be
// a crashed prior run of THIS runner (v1 assumes exactly one runner process
// — see BUILD.md "Out of scope for v1"). Blanket-resetting every 'running'
// row to 'queued' is correct only under that assumption; a multi-runner
// setup needs per-job leases (e.g. a claimed_by + heartbeat column) instead
// of this global reset, or two runners could both grab the same crashed job.
const { error: recoverError } = await supabase
  .from('enrichment_jobs')
  .update({ status: 'queued' })
  .eq('status', 'running');
if (recoverError) {
  console.error(`FATAL: crash-recovery reset failed: ${recoverError.message}`);
  process.exit(1);
}

// Runs claude -p exactly per test-run.sh's contract: args array (no shell),
// launched with cwd = the plugin directory so skill discovery works.
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        '-p',
        prompt,
        '--plugin-dir',
        PLUGIN_DIR,
        '--output-format',
        'json',
        '--tools',
        'WebSearch,WebFetch',
        '--permission-mode',
        'dontAsk',
        '--json-schema',
        schemaText,
      ],
      { cwd: PLUGIN_DIR }
    );
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
}

while (true) {
  const { data: queued, error: queuedError } = await supabase
    .from('enrichment_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at')
    .limit(1);
  if (queuedError) throw queuedError;

  const job = queued?.[0];
  if (!job) {
    await sleep(POLL_INTERVAL_MS);
    continue;
  }

  const { data: claimed, error: claimError } = await supabase
    .from('enrichment_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select();
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) {
    // Lost a race to claim this job — defensive only, a single runner
    // shouldn't ever hit this.
    continue;
  }

  console.log(`claimed job ${job.id} (company ${job.company_id})`);

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('*')
    .eq('id', job.company_id)
    .single();
  if (companyError) throw companyError;

  const previousStatus = company.status;
  await supabase.from('companies').update({ status: 'in_progress' }).eq('id', company.id);

  // Prompt-input safety (quote/newline/domain validation) lands in Task 5 —
  // for now these inputs are trusted (Runner Test Co + the seeded companies).
  const prompt = `/company-preview name="${company.name}" domain="${company.domain}" newsroom_url="${company.newsroom_url ?? ''}"`;

  console.log(`invoking claude -p for company ${company.id} (${company.name})`);
  const stdout = await runClaude(prompt);

  // Happy path only — the loud-failure shape check (missing structured_output,
  // non-JSON stdout, etc.) is Task 5.
  const structured = JSON.parse(stdout).at(-1).structured_output;

  const factRows = structured.facts.map((f) => ({
    company_id: company.id,
    section: f.section,
    text: f.text,
    fact_date: f.fact_date,
    group_key: f.group_key,
    // status defaults to 'suggested' — not set here.
  }));
  const { data: insertedFacts, error: factsError } = await supabase.from('facts').insert(factRows).select('id');
  if (factsError) throw factsError;

  const sourceRows = structured.facts.flatMap((f, i) =>
    f.sources.map((s) => ({
      fact_id: insertedFacts[i].id,
      publisher: s.publisher,
      title: s.title,
      url: s.url,
      year: s.year,
    }))
  );
  if (sourceRows.length > 0) {
    const { error: sourcesError } = await supabase.from('sources').insert(sourceRows);
    if (sourcesError) throw sourcesError;
  }

  const { error: companyDoneError } = await supabase
    .from('companies')
    .update({
      tldr: structured.tldr,
      newsroom_url: company.newsroom_url ?? structured.newsroom_url,
      status: 'ready',
    })
    .eq('id', company.id);
  if (companyDoneError) throw companyDoneError;

  const { error: jobDoneError } = await supabase
    .from('enrichment_jobs')
    .update({ status: 'done', finished_at: new Date().toISOString() })
    .eq('id', job.id);
  if (jobDoneError) throw jobDoneError;

  console.log(`done: job ${job.id} (company ${company.id}), previous company status was '${previousStatus}'`);
}
