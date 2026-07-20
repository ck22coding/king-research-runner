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
// Hard ceiling on a single claude -p run. Env-overridable for tests; default
// is generous because real research runs take 5-15 minutes (see BUILD.md).
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 20 * 60 * 1000;
// ponytail: fixed grace between SIGTERM and SIGKILL, no env override — this
// is a "give it a moment to clean up" cushion, not a tunable knob like the
// timeout itself.
const CLAUDE_KILL_GRACE_MS = 5000;
// Model for research runs. Empty = the CLI's default model. Set
// RUNNER_MODEL=sonnet to trade research depth for usage headroom.
const RUNNER_MODEL = process.env.RUNNER_MODEL || '';
// Jobs processed at once (in-process workers). The conditional claim in the
// worker loop is atomic — the loser gets 0 rows back — so workers can't
// double-claim, and boot crash-recovery stays safe: still one runner process.
// Clamped to [1, 8]: negative/NaN/fractional env values fall back sanely and
// a fat-fingered large value can't stampede the DB or the claude CLI.
const CONCURRENCY = Math.min(8, Math.max(1, Math.trunc(Number(process.env.RUNNER_CONCURRENCY)) || 2));
// On-demand mode: drain whatever is queued right now, then exit — no resident
// daemon. A launchd LaunchAgent (see launchd/) fires this on an interval
// instead of a `while(true)` process staying up. `--once` is accepted as a
// CLI flag too so it's easy to try by hand alongside the env var.
const RUNNER_ONCE = process.env.RUNNER_ONCE === '1' || process.argv.includes('--once');

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
let schema;
try {
  schemaText = readFileSync(SCHEMA_PATH, 'utf8');
  schema = JSON.parse(schemaText);
} catch (err) {
  console.error(`FATAL: could not read/parse output schema at ${SCHEMA_PATH} (${err.message})`);
  process.exit(1);
}

// Second (lightweight) validation check reads its required-field lists and
// section enum straight off the schema itself rather than hardcoding a
// second copy — same "hand-rolled, schema-specific check, not a general
// JSON-Schema validator" philosophy test-run.sh's grade() function uses.
const TOP_LEVEL_REQUIRED = schema.required;
const FACT_REQUIRED = schema.properties.facts.items.required;
const SECTION_ENUM = schema.properties.facts.items.properties.section.enum;

// Ported verbatim from test-run.sh's main() three input checks (see that
// script) — trust-boundary validation on company data that came from the DB
// but originated as free-text user input, before any of it is interpolated
// into the claude -p prompt. Returns an error string, or null if valid.
// Characters that must never be interpolated into the claude -p prompt from
// stored or user-typed data — shared by validateInputs and the known_urls
// hint so the unsafe set can't drift between the two checks.
function hasUnsafePromptChars(s) {
  return s.includes('"') || s.includes('\n');
}

function validateInputs(name, domain, newsroomUrl) {
  if (hasUnsafePromptChars(name)) {
    return 'company name must not contain double quotes or newlines';
  }
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) {
    return 'domain must be a bare domain (letters/digits/dots/dashes only)';
  }
  if (newsroomUrl != null && !/^https?:\/\/[^"\s]+$/.test(newsroomUrl)) {
    return 'newsroom_url must be an http(s) URL with no quotes or whitespace';
  }
  return null;
}

function snippet(s, n = 300) {
  if (!s) return '(empty)';
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// Dedup key for suggested-source URLs: lowercase host minus www., path minus
// trailing slashes; protocol/query/fragment dropped (tracking params, http vs
// https). Known gap: a story resurfacing under a genuinely different URL is
// NOT caught — needs group_key/text-similarity matching, out of scope for v1.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${pathname}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

// The hard gate: replicates test-run.sh's loud-failure shape check
// (`jq -e '(type == "array") and ((.[-1].structured_output? | type) == "object")'`)
// plus the process-level failure modes test-run.sh's `set -euo pipefail`
// would already have caught for it (spawn error, non-zero exit). Must run to
// completion — and pass — before any facts/sources/company write is
// attempted. Returns { ok: true, structured } or { ok: false, error }.
function checkShape({ stdout, stderr, code, spawnError, timedOut, overflowed }) {
  if (overflowed) {
    return {
      ok: false,
      error: `claude output exceeded the 10MB cap and the process was killed. stderr: ${snippet(stderr)}`,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      error: `claude -p hit its ${CLAUDE_TIMEOUT_MS}ms timeout and was killed. stderr: ${snippet(stderr)} stdout: ${snippet(stdout)}`,
    };
  }
  if (spawnError) {
    return { ok: false, error: `claude process failed to spawn: ${spawnError.message}` };
  }
  if (code !== 0) {
    return {
      ok: false,
      error: `claude exited with code ${code}. stderr: ${snippet(stderr)} stdout: ${snippet(stdout)}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: `claude stdout did not parse as JSON (${err.message}). stdout: ${snippet(stdout)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `claude stdout did not parse as a JSON array. stdout: ${snippet(stdout)}` };
  }
  const structured = parsed.at(-1)?.structured_output;
  if (structured === null || typeof structured !== 'object' || Array.isArray(structured)) {
    return {
      ok: false,
      error: `claude output has no structured_output object at .at(-1).structured_output. stdout: ${snippet(stdout)}`,
    };
  }
  return { ok: true, structured };
}

// Lightweight second check: hand-rolled loop over output-schema.json's own
// required arrays + section enum (see TOP_LEVEL_REQUIRED/FACT_REQUIRED/
// SECTION_ENUM above). Returns an error string, or null if valid.
function checkAgainstSchema(structured) {
  for (const key of TOP_LEVEL_REQUIRED) {
    if (!(key in structured)) return `structured_output missing required key: ${key}`;
  }
  if (!Array.isArray(structured.facts)) return 'structured_output.facts is not an array';
  for (const [i, fact] of structured.facts.entries()) {
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) {
      return `facts[${i}] is not an object`;
    }
    for (const key of FACT_REQUIRED) {
      if (!(key in fact)) return `facts[${i}] missing required key: ${key}`;
    }
    if (!SECTION_ENUM.includes(fact.section)) {
      return `facts[${i}].section '${fact.section}' is not one of the 8-value enum`;
    }
    // Nested sources must be fully valid BEFORE any DB write — facts insert
    // first, so a malformed source discovered mid-write would strand
    // already-inserted facts (codex review).
    if (!Array.isArray(fact.sources) || fact.sources.length < 1) {
      return `facts[${i}].sources is not a non-empty array`;
    }
    for (const [j, s] of fact.sources.entries()) {
      if (s === null || typeof s !== 'object' || Array.isArray(s)) {
        return `facts[${i}].sources[${j}] is not an object`;
      }
      if (typeof s.publisher !== 'string' || s.publisher.length === 0) {
        return `facts[${i}].sources[${j}].publisher is not a non-empty string`;
      }
      if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) {
        return `facts[${i}].sources[${j}].url is not an http(s) URL`;
      }
      if (s.year !== null && !Number.isInteger(s.year)) {
        return `facts[${i}].sources[${j}].year is not an integer or null`;
      }
      if (s.title !== null && typeof s.title !== 'string') {
        return `facts[${i}].sources[${j}].title is not a string or null`;
      }
    }
  }
  return null;
}

// On-demand starts are short-lived and frequent (launchd fires every 60s),
// so it's routine for a second instance to start while a first is still
// genuinely mid-job (a manual run overlapping a launchd tick, or two ticks
// overlapping if a run ever took >60s). A blanket reset of every 'running'
// row would yank that in-flight job back to 'queued' out from under the
// still-running instance — it could then get re-claimed and re-run, i.e. a
// real, paid claude -p research call executed twice.
//
// Fix: only reset rows whose claim (started_at) is older than a staleness
// threshold comfortably beyond the longest a job can legitimately still be
// running. That worst case is two claude -p attempts (the one transient-
// error retry) plus the 60s retry sleep and both kill-grace windows, plus a
// safety margin — so a row this old was never going to still be running; it
// can only be a crashed prior run. A genuinely-in-flight job's started_at is
// always well inside this window, so a concurrently-started instance leaves
// it alone. Tradeoff: a real crash isn't unwedged until the row goes stale,
// not on the very next start — correct-but-slower beats fast-but-unsafe here.
const CRASH_RECOVERY_STALE_MS = 2 * CLAUDE_TIMEOUT_MS + 60_000 + 2 * CLAUDE_KILL_GRACE_MS + 60_000;
const { error: recoverError } = await supabase
  .from('enrichment_jobs')
  .update({ status: 'queued' })
  .eq('status', 'running')
  .lt('started_at', new Date(Date.now() - CRASH_RECOVERY_STALE_MS).toISOString());
if (recoverError) {
  console.error(`FATAL: crash-recovery reset failed: ${recoverError.message}`);
  process.exit(1);
}

// Runs claude -p exactly per test-run.sh's contract: args array (no shell),
// launched with cwd = the plugin directory so skill discovery works. Never
// rejects — resolves with everything checkShape() needs (stdout, stderr,
// exit code, spawn error, timedOut) so failure classification happens in one
// place. Hard-times-out at CLAUDE_TIMEOUT_MS: SIGTERM first, then SIGKILL if
// the child hasn't exited after CLAUDE_KILL_GRACE_MS — a run that hangs
// (network stall, runaway agent loop, etc.) must never wedge the queue.
function runClaude(prompt) {
  return new Promise((resolve) => {
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
        ...(RUNNER_MODEL ? ['--model', RUNNER_MODEL] : []),
        '--json-schema',
        schemaText,
      ],
      { cwd: PLUGIN_DIR }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let killTimer;
    // ponytail: 10MB cap — a healthy run's JSON is ~250KB; a runaway child
    // must not OOM the runner (codex review).
    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, CLAUDE_KILL_GRACE_MS);
    }, CLAUDE_TIMEOUT_MS);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve(result);
    };
    const capped = (d) => {
      if (stdout.length + stderr.length + d.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill('SIGKILL');
        return false;
      }
      return true;
    };
    child.stdout.on('data', (d) => capped(d) && (stdout += d));
    child.stderr.on('data', (d) => capped(d) && (stderr += d));
    child.on('error', (spawnError) => finish({ stdout, stderr, code: null, spawnError, timedOut, overflowed }));
    child.on('close', (code) => finish({ stdout, stderr, code, spawnError: null, timedOut, overflowed }));
  });
}

// In-flight company ids across all workers in this process. Checked and
// updated with no await in between, so two workers can never both pass the
// check for one company — two queued jobs for the same company must run
// serially (concurrent runs would snapshot the same dedup history and race
// on the companies row). Complete only because v1 runs exactly ONE runner
// process (see the boot-recovery comment above).
const activeCompanies = new Set();

// Flipped when any worker's failure path can't even record a failure. All
// workers then finish their CURRENT job (protecting in-flight writes) and
// stop picking up new ones, so Promise.all below resolves and the process
// actually exits (code 1) — a live-but-wedged runner would never trigger
// boot crash-recovery for the stuck job.
let shuttingDown = false;

async function worker() {
  while (!shuttingDown) {
    // ponytail: 10-row scan window — enough to skip past a locked company's
    // queued jobs at this scale; if all 10 are on locked companies we just
    // wait one poll interval.
    const { data: queued, error: queuedError } = await supabase
      .from('enrichment_jobs')
      .select('*')
      .eq('status', 'queued')
      .order('created_at')
      .limit(10);
    // Transient DB errors while polling must not crash the runner — log,
    // sleep, retry (codex review).
    if (queuedError) {
      console.error(`poll error (will retry): ${queuedError.message}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const job = (queued ?? []).find((j) => !activeCompanies.has(j.company_id));
    if (!job) {
      // Once-mode: nothing claimable right now (queue empty, or every queued
      // row belongs to a company a sibling worker is already mid-job on).
      // Return instead of sleeping — a sibling still holding a company lock
      // keeps looping and will pick up any job behind it once it frees that
      // lock, so no job is stranded (see README "How it runs jobs").
      if (RUNNER_ONCE) {
        console.log('once-mode: no claimable job, worker exiting');
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    activeCompanies.add(job.company_id);

    try {
      // 'halt' means this worker's failure path could not even record a
      // failure — begin shutdown: siblings drain their current job, then
      // the process exits so the next start's crash-recovery unwedges state.
      if ((await runJob(job)) === 'halt') {
        shuttingDown = true;
        return;
      }
    } finally {
      activeCompanies.delete(job.company_id);
    }
  }
}

// Claims and processes one queued job to a terminal state. Returns 'halt'
// only when the failure path itself failed and this worker must stop.
async function runJob(job) {
  const { data: claimed, error: claimError } = await supabase
    .from('enrichment_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select();
  if (claimError) {
    console.error(`claim error (will retry): ${claimError.message}`);
    await sleep(POLL_INTERVAL_MS);
    return;
  }
  if (!claimed || claimed.length === 0) {
    // Lost the row-level claim race to a sibling worker — routine under
    // in-process concurrency.
    return;
  }

  console.log(`claimed job ${job.id} (company ${job.company_id})`);

  // Tracks the company's status as it was found before this job touched it,
  // so the catch block below knows what to restore it to. Stays undefined
  // until the company row is actually fetched — if that fetch itself fails,
  // nothing was ever flipped, so there is nothing to restore.
  let previousStatus;
  // Fact ids inserted by this job, for compensation if a later write fails.
  let insertedFactIds = [];

  try {
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('*')
      .eq('id', job.company_id)
      .single();
    if (companyError) throw companyError;

    previousStatus = company.status;

    // Trust-boundary check on DB-sourced, user-typed company fields, run
    // BEFORE any status flip — invalid input means the company row is never
    // touched (nothing flipped, nothing to restore), only the job fails.
    const inputError = validateInputs(company.name, company.domain, company.newsroom_url);
    if (inputError) {
      const { error: jobFailError } = await supabase
        .from('enrichment_jobs')
        .update({ status: 'failed', error: `invalid company inputs: ${inputError}`, finished_at: new Date().toISOString() })
        .eq('id', job.id);
      if (jobFailError) throw jobFailError;
      console.error(`job ${job.id} failed input validation: ${inputError}`);
      return;
    }

    // Independent operations (both only need company.id) — one round-trip.
    const [{ error: inProgressError }, { data: existingSources, error: existingSourcesError }] =
      await Promise.all([
        supabase.from('companies').update({ status: 'in_progress' }).eq('id', company.id),
        // No repeat suggestions: the sources table IS the log, tagged via its
        // fact's status. Pull every URL ever suggested for this company, any
        // status — approved, rejected, and still-pending all count.
        supabase
          .from('sources')
          .select('url, facts!inner(created_at)')
          .eq('facts.company_id', company.id)
          .order('facts(created_at)', { ascending: false }),
      ]);
    if (inProgressError) throw inProgressError;
    if (existingSourcesError) throw existingSourcesError;

    const knownNormalized = new Set(); // authoritative, unbounded — the insert filter uses this
    const knownUrls = []; // capped hint for the prompt, most-recent first
    // ponytail: caps the PROMPT hint only; knownNormalized is never capped,
    // so correctness never depends on this. Raise if a company passes 150+
    // distinct prior sources and repeats still slip past the model.
    const EXCLUDE_URL_CAP = 150;
    for (const s of existingSources ?? []) {
      const norm = normalizeUrl(s.url);
      if (knownNormalized.has(norm)) continue;
      knownNormalized.add(norm);
      // A stray `"`/newline must not break the known_urls="..." arg, and a
      // comma is the list delimiter — a URL containing one would garble the
      // list, so it stays in knownNormalized but out of the prompt hint.
      if (knownUrls.length < EXCLUDE_URL_CAP && !hasUnsafePromptChars(s.url) && !s.url.includes(',')) {
        knownUrls.push(s.url);
      }
    }
    const knownUrlsArg = knownUrls.length > 0 ? ` known_urls="${knownUrls.join(',')}"` : '';

    const prompt = `/company-preview name="${company.name}" domain="${company.domain}" newsroom_url="${company.newsroom_url ?? ''}"${knownUrlsArg}`;

    console.log(`invoking claude -p for company ${company.id} (${company.name})`);
    let result = await runClaude(prompt);
    // One retry for transient API failures ("API Error: 529 Overloaded" etc.)
    // — those die in seconds and cost ~no tokens, unlike a real research run.
    // Alternation is scoped: a bare "overloaded" in fetched article text must
    // NOT look transient. ponytail: single retry, fixed delay; a backoff
    // loop is the upgrade path.
    if (result.code !== 0 && /API Error: (5\d\d|overloaded)/i.test(result.stdout + result.stderr)) {
      console.error(`job ${job.id}: transient API error, retrying once in 60s`);
      await sleep(60_000);
      result = await runClaude(prompt);
    }

    // Hard gate: must run to completion, and pass, before any facts/sources/
    // company write is attempted.
    const shape = checkShape(result);
    if (!shape.ok) throw new Error(shape.error);
    const schemaError = checkAgainstSchema(shape.structured);
    if (schemaError) throw new Error(`structured_output failed schema check: ${schemaError}`);

    const structured = shape.structured;

    // Drop repeat suggestions: if ANY cited source URL (normalized) is
    // already known, drop the WHOLE fact — every source must be the specific
    // supporting article (SKILL.md sourcing rules), so a match means the same
    // underlying story. The earlier fact's status doesn't matter.
    const newFacts = structured.facts.filter(
      (f) => !f.sources.some((s) => knownNormalized.has(normalizeUrl(s.url)))
    );
    const skipped = structured.facts.length - newFacts.length;
    if (skipped > 0) {
      console.log(`job ${job.id}: skipped ${skipped} repeat fact(s) for company ${company.id}`);
    }

    const factRows = newFacts.map((f) => ({
      company_id: company.id,
      section: f.section,
      text: f.text,
      fact_date: f.fact_date,
      group_key: f.group_key,
      // status defaults to 'suggested' — not set here.
    }));
    const { data: insertedFacts, error: factsError } = await supabase.from('facts').insert(factRows).select('id');
    if (factsError) throw factsError;
    insertedFactIds = insertedFacts.map((f) => f.id);

    const sourceRows = newFacts.flatMap((f, i) =>
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
  } catch (err) {
    // Any thrown error (network, DB write failure mid-run, shape/schema
    // gate, etc.) lands here: job failed + company restored, never a crashed
    // process or a wedged queue.
    console.error(`job ${job.id} failed: ${err.message}`);

    // Loud failure: macOS banner so a dead run is never silent. The web UI
    // shows the same error on the company row; this covers eyes-off-the-app.
    const banner = spawn('osascript', [
      '-e',
      // Backslashes are escape intros inside AppleScript string literals
      // (and routine in error text that embeds JSON snippets) — swap them
      // out along with quotes or the banner itself dies silently.
      `display notification "${String(err.message).slice(0, 120).replace(/[\\"]/g, "'")}" with title "CRM runner: job failed"`,
    ]);
    // Best-effort: spawn failures surface as an async 'error' event;
    // unhandled, that crashes the whole process from the notification path.
    banner.on('error', () => {});

    // Compensation for partial writes: no DELETE policy exists, so facts
    // inserted before a later write failed are marked rejected (hidden in
    // the UI). ponytail: an insert_brief RPC (one transaction) is the
    // upgrade path if orphaned-rejected rows ever matter (codex review).
    if (insertedFactIds.length > 0) {
      const { error: compError } = await supabase
        .from('facts')
        .update({ status: 'rejected' })
        .in('id', insertedFactIds);
      if (compError) {
        console.error(
          `compensation failed — ${insertedFactIds.length} suggested fact(s) from failed job ${job.id} left behind: ${compError.message}`
        );
      }
    }

    // The failure-path writes themselves must be checked: supabase-js
    // returns {error}, it doesn't throw. If we can't record the failure,
    // exit — boot crash-recovery resets running→queued on the next start,
    // which is the one reliable unwedge (codex review).
    // Order matters: restore the company FIRST, job status LAST — the job's
    // terminal status is the commit signal observers (UI, tests) key off,
    // so all other state must be consistent before it flips (mirrors the
    // success path, where the company update precedes job 'done').
    let restoreError = null;
    if (previousStatus !== undefined) {
      ({ error: restoreError } = await supabase
        .from('companies')
        .update({ status: previousStatus })
        .eq('id', job.company_id));
    }
    const { error: failWriteError } = await supabase
      .from('enrichment_jobs')
      .update({ status: 'failed', error: err.message, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    if (failWriteError || restoreError) {
      console.error(
        `FATAL: failure-path write failed (job: ${failWriteError?.message ?? 'ok'}, company: ${restoreError?.message ?? 'ok'}) — halting this worker; boot crash-recovery resets the job on next restart`
      );
      // Not process.exit(1): that would kill sibling workers mid-write,
      // stranding their facts and companies. Halt this worker alone; the
      // process exits (code 1) only once every worker has halted.
      process.exitCode = 1;
      return 'halt';
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
// Once-mode only reaches here: every worker drained the queue and returned.
// No explicit process.exit() needed — nothing left keeps the event loop
// alive (the Supabase auth client's refresh timer is unref'd), so the
// process exits on its own with whatever process.exitCode was set (0
// unless a worker halted above).
if (RUNNER_ONCE) console.log('once-mode: queue drained, exiting');
