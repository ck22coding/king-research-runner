#!/usr/bin/env node
// Stand-in for a wedged deck-build script. Ignores SIGTERM on purpose — the
// only way this fixture ever terminates is the wrapper's SIGKILL fallback,
// which is exactly the mechanic this fixture exists to prove.
import { setTimeout as sleep } from 'node:timers/promises';

process.on('SIGTERM', () => {});

await sleep(30_000); // never reached in a passing test run
