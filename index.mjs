#!/usr/bin/env node
// Local enrichment runner: polls Supabase for queued enrichment_jobs, claims
// one at a time, invokes the company-preview claude -p skill, and writes
// suggested facts/sources back to the DB. Startup only so far — polling
// loop lands in a later task.
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';

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

// ponytail: placeholder poll loop so the process stays alive — Task 4 fills
// in the real claim/run/write logic.
while (true) {
  await sleep(POLL_INTERVAL_MS);
}
