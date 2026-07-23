#!/usr/bin/env node
// Records what each node was actually spawned with (section, --model, the
// fetch_budget passed to the skill) to $KR_RECORD_FILE, then answers normally.
// The money table in the spec is only real if it reaches the wire.
import { appendFileSync } from 'node:fs';
import { respond, promptArg, nodeKind } from './fake-claude-lib.mjs';

const prompt = promptArg();
const kind = nodeKind(prompt);
const modelIdx = process.argv.indexOf('--model');
const model = modelIdx === -1 ? '' : process.argv[modelIdx + 1];
const budget = prompt.match(/\bfetch_budget=(\d+)/)?.[1] ?? '';

if (process.env.KR_RECORD_FILE && (kind === 'scout' || kind.startsWith('topic:'))) {
  appendFileSync(process.env.KR_RECORD_FILE, `${kind}\t${model}\t${budget}\n`);
}

respond({ facts: () => [] });
