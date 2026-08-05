#!/usr/bin/env node
// Fake `claude` binary for the dedup-concurrency regression test: sleeps
// before answering the scout call, holding the job in 'running' for the
// delay so a sibling job (a different market) has a wide window to prove it
// wasn't blocked by the first job's in-flight dedup guard. Every other node
// gets the boring default (respondMarket's facts default to none).
import { setTimeout as sleep } from 'node:timers/promises';
import { promptArg, nodeKind } from './fake-claude-lib.mjs';
import { respondMarket } from './fake-market-claude-lib.mjs';

if (nodeKind(promptArg()) === 'scout') await sleep(2000);
respondMarket({});
