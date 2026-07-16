#!/usr/bin/env node
// Fake `claude` binary for the runner's hard-timeout test: sleeps far past
// any test's CLAUDE_TIMEOUT_MS, so the only thing that can end this process
// is the runner's timeout+kill path. No signal handlers registered — a bare
// SIGTERM kills it immediately, same as an unmodified `claude` CLI process
// would by default.
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(600_000); // 10 minutes — never reached in a passing test run
console.log(JSON.stringify([{ structured_output: {} }]));
