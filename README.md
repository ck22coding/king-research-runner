# king-research-runner

Local research runner for [King Research CRM](https://king-research.vercel.app)
— your computer is the backend. The website only inserts job rows; this
runner, signed in as *you* via a one-time pairing code, polls for jobs where
`requested_by` is your account, claims one, runs the `company-preview` skill
via `claude -p`, and writes the results (facts, sources, company
tldr/status) back to Supabase. A web click alone can't run research
directly — `claude -p` has to run on your machine, so a runner has to be up on
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
| `RUNNER_MODE` | unset | Set to `cloud` for the shared cloud runner. See below. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Required by (and only used in) cloud mode. Never set `RUNNER_MODE=cloud` on a laptop. |

## Cloud mode

`RUNNER_MODE=cloud` turns this same process into the *shared* runner: no
pairing, no stored session, and it serves **every** user's jobs rather than one
person's. Local runners keep working unchanged.

The mode has to be named explicitly — having the service key in your
environment is *not* enough, on purpose. That key already lives in dev `.env`
files because the website's server routes need it, so switching on its presence
would silently turn a laptop runner into one that serves and bills for the
whole workspace. Cloud mode also fails fast at boot if the key is missing,
rather than falling back to a pairing prompt a container can never answer.

Two things differ, and both follow from there being no human at the keyboard:

- **Billing changes.** A container has no interactive `claude` login, so it
  authenticates with `ANTHROPIC_API_KEY` and research is billed per token
  instead of riding a Max/Pro subscription. That is a cost model decision, not
  a deployment detail — set a monthly limit in the Anthropic console before
  the first deploy.
- **The service key bypasses RLS.** It can read and write every row, which is
  precisely why the runner can serve all users without a policy change. Keep
  it in `fly secrets` (or your platform's secret store) and out of the repo,
  the image, and any log line.

Deploy (`Dockerfile` + `fly.toml` are in this repo):

```
fly launch --no-deploy
fly secrets set SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=...
fly deploy
```

The image vendors the `company-preview` plugin at build time rather than
installing it from the marketplace at runtime — pin `PLUGIN_REF` to a tag if
you don't want a plugin change altering research behaviour on the next deploy.

## Cost reporting

Every `claude -p` call returns what it cost, and the pipeline runs each stage
as its own process, so the per-stage numbers are measured rather than
apportioned. After each job the runner prints the breakdown most-expensive
first and writes the same structure to `enrichment_jobs.cost`:

```
job 9f3c… cost $3.11 over 10 claude calls
  topic financials     $0.930  claude-sonnet-4-6   in 41k  out 3.1k  cache r180k/w22k  web 9  312s
  synthesis            $0.640  claude-sonnet-4-6   in 28k  out 5.0k  cache r91k/w18k   web 0  148s
  topic news            FAILED  -                  in 0    out 0     cache r0/w0       web 0  1200s
  …
```

Read it as: **the dollar column tells you where to optimize**, `web` is what
the per-section fetch budgets actually control, and `cache r…/w…` is the
cheapest thing to fix when a stage shows a large write with almost no read —
reads bill at roughly a tenth of writes, so a churning prompt prefix pays full
freight on every single run. `FAILED` marks a call that died before it could
report (usually the 20-minute timeout); it still spent money, so the total is a
floor, not an exact figure — the summary line says so when any are present.

Storing it needs one column:

```sql
alter table public.enrichment_jobs add column if not exists cost jsonb;
```

One run tells you about one run. To find the stage worth actually rewriting,
aggregate across jobs — the expensive stage is rarely the slow one:

```sql
select n->>'node'                            as node,
       count(*)                              as runs,
       round(avg((n->>'usd')::numeric), 3)   as avg_usd,
       round(sum((n->>'usd')::numeric), 2)   as total_usd,
       round(avg((n->>'web')::numeric), 1)   as avg_fetches
from public.enrichment_jobs j,
     jsonb_array_elements(j.cost->'nodes') n
where j.cost is not null
group by 1
order by total_usd desc;
```

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
`requested_by` is your own user id. (In cloud mode that boundary is
deliberately absent — see above — which is the whole reason the service key
has to be treated as a secret rather than as configuration.)

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
