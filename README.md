# king-research-runner

Local research runner for [King Research CRM](https://king-research.vercel.app)
— your computer is the backend. The website only inserts job rows; this
runner, signed in as *you* via a one-time pairing code, polls for jobs where
`requested_by` is your account, claims one, runs the `company-preview` skill
via `claude -p`, and writes the results (facts, sources, company
tldr/status) back to Supabase. A web click alone can't run research
directly — `claude -p` has to run on your machine (Anthropic policy forbids
subscription tokens powering a hosted backend), so a runner has to be up on
your machine for your jobs to get picked up. It's a single resident process:
start it and leave it running.

## Install & pair

1. Install Claude Code and sign in with your subscription:
   ```
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
2. Install the research plugin:
   ```
   claude plugin marketplace add ck22coding/king-research
   claude plugin install king-research@king-research
   ```
3. Start the runner and leave it running — it checks for your jobs every
   few seconds:
   ```
   npx king-research-runner
   ```
4. On first run (no stored session yet) it prompts for a pairing code. On
   the website, go to **Onboarding → Connect this computer**, copy the code,
   and paste it in. That's a one-time step: the runner stores the session
   locally (`KR_CREDENTIALS_PATH`) and reconnects on its own after that.

## Env overrides

All optional; sane defaults cover a normal install.

| Var | Default | Purpose |
| --- | --- | --- |
| `KR_SITE_URL` | `https://king-research.vercel.app` | Site the runner exchanges pairing codes against. |
| `KR_CREDENTIALS_PATH` | `~/.king-research/credentials.json` | Where the stored session (refresh token) lives, mode 600. |
| `KR_ENV_FILE` | `.env` | Optional env file loaded at startup (dev/test convenience). |
| `NEXT_PUBLIC_SUPABASE_URL` | the hosted project URL | Supabase project the runner talks to. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the hosted project's anon key | Public by design — RLS is the security boundary. |
| `RUNNER_QUEUE` | `prod` | Queue namespace; keeps test runs from touching real jobs. |
| `RUNNER_CONCURRENCY` | `2` (clamped 1–8) | In-process workers claiming and running jobs at once. |
| `RUNNER_MODEL` | CLI default | e.g. `sonnet`, to trade research depth for usage headroom. |
| `POLL_INTERVAL_MS` | `5000` | How often an idle worker checks for a new job. |
| `CLAUDE_BIN` | resolved via `command -v claude` | Absolute path override for non-interactive parents that don't inherit your shell's `PATH`. |
| `PLUGIN_DIR` | unset | Dev only: path to a local `company-preview/skill` checkout, passed as `--plugin-dir`. Leave unset for the marketplace-installed plugin. |

## How it runs jobs

Each worker loops: poll for a claimable queued job belonging to you (one not
already locked to a company an in-process sibling is working), claim it
atomically, run it to completion, repeat, forever, until you stop the
process. No queue library — ponytail: a while-loop with a sleep is correct
at this scale.

Each `claude -p` invocation is hard-capped at 20 minutes. If it hits the
timeout the child is killed and the job is marked failed — a hung run can
never wedge the queue. On startup, any job of yours left `status='running'`
from a crashed prior run is reset to `queued`; a genuinely fresh `running`
row is left alone so a still-in-flight job can never be re-run (real, paid
research executed twice).

## Permissions

The runner invokes `claude` with exactly:

```
--tools "WebSearch,WebFetch" --permission-mode dontAsk
```

No broader tool, file, or shell access is ever granted — the skill never
writes files or runs shell commands. Every database write (facts, sources,
company status/tldr/newsroom_url, job status) is performed by the runner
itself, in Node, and only after validating the skill's structured JSON
output — never by the `claude` process directly.

The runner's own database access is scoped down to Postgres row-level
security: it's signed in as you, and can only claim/update jobs where
`requested_by` is your own user id.

## Self-hosting

Point every `NEXT_PUBLIC_SUPABASE_*` var and `KR_SITE_URL` at your own
Supabase project and site deployment instead of the defaults, and the runner
works the same way against your own instance.

## Testing

`command npm test` runs the suite against the LIVE hosted Supabase project
(there is no local Supabase stack). `RUNNER_EMAIL`/`RUNNER_PASSWORD` sign in
a fixture account kept around for tests only — the runner itself never reads
those vars. A live runner and the test suites must not run at the same
time: stop any running `npx king-research-runner` before running tests, and
don't run tests while real jobs are queued (a runner claims the oldest
queued job, real or fixture).
