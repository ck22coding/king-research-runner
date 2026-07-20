# runner

Local enrichment runner for the research CRM. It polls the `enrichment_jobs`
table for queued jobs, runs the `company-preview` skill via `claude -p` for
the target company, and writes the results (facts, sources, company
tldr/status) back to Supabase.

## On-demand: no resident daemon

The runner only runs when there's work, and exits as soon as the queue is
empty — it does **not** sit around as an always-on background process.

- **`--once` mode** (or `RUNNER_ONCE=1`): each worker polls once; if there's
  a claimable job it runs it to completion (never abandoned mid-job), then
  polls again; the moment a poll finds nothing claimable, that worker
  returns. Once every worker has returned, the process exits naturally —
  with no queued work, a start-to-exit cycle takes well under a second.
- A **launchd LaunchAgent** (`launchd/com.kingresearch.runner.plist`) fires
  the runner in `--once` mode on a 60s interval, so "click Enrich → wait a
  minute → it runs" without anything staying resident. See "launchd setup"
  below.
- A web click alone can't start it directly — `claude -p` has to run on this
  Mac (Anthropic policy forbids subscription tokens powering a hosted
  backend), and the Vercel-hosted web app can't reach into this laptop.
  launchd waking up periodically is what closes that gap.

**Tradeoff:** jobs sit `queued` while the Mac is asleep or off — launchd runs
the one missed tick on wake, it does not "catch up" on every interval that
was skipped, so there's no pile-up. Enrich something, then wake/unlock the
Mac within a minute or so for it to run.

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
any non-interactive launch context. `launchd/com.kingresearch.runner.plist`
already sets it for you.

## How it runs jobs

`RUNNER_CONCURRENCY` (default 2, clamped 1–8) in-process workers each loop:
poll for a claimable queued job (one not already locked to a company an
in-process sibling is working), claim it atomically, run it to completion,
repeat. No queue library — ponytail: a while-loop with a sleep is correct at
this scale. In continuous mode (below) each empty poll sleeps
`POLL_INTERVAL_MS` (default 5s) before retrying; in `--once` mode an empty
poll ends that worker instead (see "On-demand" above).

Each `claude -p` invocation is hard-capped at `CLAUDE_TIMEOUT_MS` (default 20
minutes). If it hits the timeout the child is killed and the job is marked
failed — a hung run can never wedge the queue.

### Crash recovery

On startup, any job left `status='running'` with a `started_at` older than a
staleness threshold (`CRASH_RECOVERY_STALE_MS` in `index.mjs` — comfortably
more than twice `CLAUDE_TIMEOUT_MS`, covering the one transient-error retry
plus its 60s delay and kill-grace windows, plus margin) is reset to
`queued`. A row that old can only be a crashed prior run.

The staleness gate exists *because* the runner is on-demand: short-lived
starts on a 60s interval make it routine for a second instance to start
while a first is still genuinely mid-job. A blanket "reset every `running`
row" (correct for a single long-lived daemon) would yank that in-flight job
back to `queued` out from under the still-running instance — it could then
get re-claimed and re-run, i.e. real, paid research executed twice. Gating
on staleness means a fresh `running` row (genuinely in flight) is left
alone; only a row old enough to be unambiguously crashed gets reset. The
tradeoff: an actual crash isn't unwedged on the very next start, only once
the row goes stale — correct-but-slower beats fast-but-unsafe here.

## Running it

### On-demand (normal use): launchd

Install the LaunchAgent so the runner fires automatically on a 60s interval
whenever there's queued work:

```
cp launchd/com.kingresearch.runner.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kingresearch.runner.plist
```

Check it's loaded: `launchctl list | grep kingresearch`. Logs go to
`launchd/runner.stdout.log` and `launchd/runner.stderr.log` in this repo
(gitignored).

To stop/uninstall:

```
launchctl unload ~/Library/LaunchAgents/com.kingresearch.runner.plist
rm ~/Library/LaunchAgents/com.kingresearch.runner.plist
```

launchd will not start a second instance while one from a prior tick is
still running, so an occasional long research run just means that tick's
sibling ticks no-op until it's done — no pile-up, no double-run.

If the `node` or `claude` binary paths in the `.plist` ever stop matching
this machine (Node version manager upgrade, etc.), update the absolute
paths in `launchd/com.kingresearch.runner.plist` and reload
(`launchctl unload` then `launchctl load` again).

### Continuous mode (debugging)

For interactive debugging — watching logs live, iterating quickly — run the
old always-polling mode directly in a terminal:

```
node index.mjs
```

This is the pre-on-demand behavior: a resident process that polls forever
until you Ctrl-C it. Useful when you want to watch a job run in real time
without waiting for the next launchd tick. **Don't leave this running** —
see "Operational notes" below on why a live process and the test suite must
never overlap.

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

A live runner (any of: continuous `node index.mjs`, a manual `--once` run,
or the launchd LaunchAgent loaded) and the test suites must not run at the
same time — both learned the hard way on 2026-07-16, and the hazard is
unchanged by the on-demand switch, just the trigger is different now:

- **Unload the LaunchAgent (and make sure no continuous-mode process is
  running) before running any test suite** (this repo's, or `web`'s
  Playwright E2E): `launchctl unload
  ~/Library/LaunchAgents/com.kingresearch.runner.plist`. Tests insert
  `queued` jobs and expect them to stay queued; a real runner invocation
  (real `CLAUDE_BIN`, no test override) claims them and launches a real,
  paid `claude -p` research run on a test/fixture company. If a launchd
  tick fires mid-test-run, it will do exactly this.
- **Don't run this repo's tests while real jobs are queued.** The lifecycle
  tests spawn real runner processes (with a fake `claude`), and a runner
  claims the *oldest* queued job — which could be a real company's. With no
  real jobs queued, the fixture jobs are all it can grab.
