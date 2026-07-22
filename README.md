# runner

Local enrichment runner for the research CRM. It polls the `enrichment_jobs`
table for queued jobs, runs the `company-preview` skill via `claude -p` for
the target company, and writes the results (facts, sources, company
tldr/status) back to Supabase.

## Continuous mode

The runner is a single resident process: start it and leave it running. It
polls on an interval (`POLL_INTERVAL_MS`, default 5s) and claims + runs any
job it finds, forever, until you stop it. A web click alone can't run
research directly — `claude -p` has to run on your machine (Anthropic policy
forbids subscription tokens powering a hosted backend), so a runner has to be
up for jobs to get picked up.

## Setup

Requires `/Users/carterking/Projects/dad/.env` (the repo root `.env`, read in
place — this repo never copies or commits it) with:

- `RUNNER_EMAIL`
- `RUNNER_PASSWORD`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Install and run:

```
npm install
node index.mjs
```

### CLAUDE_BIN

The runner resolves the `claude` binary once at startup: `CLAUDE_BIN` env var
if set, else `command -v claude`. It fails loudly and exits if neither
resolves. This matters for any non-interactive parent process, which won't
inherit your interactive shell's `PATH` — `claude` may work fine in your
terminal but be invisible there. Set `CLAUDE_BIN` to the absolute path in
that case.

## How it runs jobs

`RUNNER_CONCURRENCY` (default 2, clamped 1–8) in-process workers each loop:
poll for a claimable queued job (one not already locked to a company an
in-process sibling is working), claim it atomically, run it to completion,
repeat. No queue library — ponytail: a while-loop with a sleep is correct at
this scale. Each empty poll sleeps `POLL_INTERVAL_MS` before retrying.

Each `claude -p` invocation is hard-capped at `CLAUDE_TIMEOUT_MS` (default 20
minutes). If it hits the timeout the child is killed and the job is marked
failed — a hung run can never wedge the queue.

### Crash recovery

On startup, any job left `status='running'` with a `started_at` older than a
staleness threshold (`CRASH_RECOVERY_STALE_MS` in `index.mjs` — comfortably
more than twice `CLAUDE_TIMEOUT_MS`, covering the one transient-error retry
plus its 60s delay and kill-grace windows, plus margin) is reset to
`queued`. A row that old can only be a crashed prior run — a genuinely
fresh `running` row is left alone so a still-in-flight job can never be
yanked back to `queued` and re-run (real, paid research executed twice).

## Permissions

The runner invokes `claude` with exactly:

```
--tools "WebSearch,WebFetch" --permission-mode dontAsk
```

— the same flags `company-preview/skill/test-run.sh` uses to run this skill
headlessly. No broader tool, file, or shell access is ever granted, because
the skill never writes files or runs shell commands. Every database write
(facts, sources, company status/tldr/newsroom_url, job status) is performed
by the runner itself, in Node, and only after validating the skill's
structured JSON output — never by the `claude` process directly.

This replicates test-run.sh's flag-based contract rather than a dedicated
settings file: functionally identical, one fewer file to maintain.

The runner's own database access is likewise scoped down: it signs in as an
ordinary authenticated user (email + password from `.env`) whose write
access comes entirely from that account's `can_enrich=true` flag. No
service-role key is used anywhere.

## Operational notes (tests vs. a live runner)

A live runner and the test suites must not run at the same time — both
learned the hard way on 2026-07-16:

- **Stop any running `node index.mjs` before running any test suite** (this
  repo's, or `web`'s Playwright E2E). Tests insert `queued` jobs and expect
  them to stay queued; a real runner invocation (real `CLAUDE_BIN`, no test
  override) claims them and launches a real, paid `claude -p` research run
  on a test/fixture company.
- **Don't run this repo's tests while real jobs are queued.** The lifecycle
  tests spawn real runner processes (with a fake `claude`), and a runner
  claims the *oldest* queued job — which could be a real company's. With no
  real jobs queued, the fixture jobs are all it can grab.
