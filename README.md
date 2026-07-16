# runner

Local enrichment runner for the research CRM. It polls the `enrichment_jobs`
table for queued jobs, runs the `company-preview` skill via `claude -p` for
the target company, and writes the results (facts, sources, company
tldr/status) back to Supabase.

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
resolves. This matters because daemon/launchd contexts don't inherit your
interactive shell's `PATH` — `claude` may work fine in your terminal but be
invisible to a background process. Set `CLAUDE_BIN` to the absolute path in
any non-interactive launch context.

## How it runs jobs

One job at a time, by construction: a single `while (true)` loop with a
`sleep` between polls (`POLL_INTERVAL_MS`, default 5s). No queue library —
ponytail: a while-loop with a sleep is correct at this scale.

Each `claude -p` invocation is hard-capped at `CLAUDE_TIMEOUT_MS` (default 20
minutes). If it hits the timeout the child is killed and the job is marked
failed — a hung run can never wedge the queue.

### Crash recovery

On startup, any job left in `status='running'` is reset to `queued`. A
`running` job found at boot can only be a crashed prior run — ponytail:
this assumes a single runner process; a multi-runner setup would need
per-job leases (e.g. a `claimed_by` + heartbeat column) instead of this
blanket reset, or two runners could grab the same crashed job.

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

The daemon and the test suites must not run at the same time — both learned
the hard way on 2026-07-16:

- **Stop the daemon before running any test suite** (this repo's, or
  `web/`'s Playwright E2E). Tests insert `queued` jobs and expect them to
  stay queued; a live daemon claims them and launches a real, paid
  `claude -p` research run on a test/fixture company.
- **Don't run this repo's tests while real jobs are queued.** The lifecycle
  tests spawn real runner processes (with a fake `claude`), and a runner
  claims the *oldest* queued job — which could be a real company's. With no
  real jobs queued, the fixture jobs are all it can grab.
