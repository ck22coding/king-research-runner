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

// The tldr node's --json-schema, recorded to its OWN file: the money-table
// test asserts an exact node count against KR_RECORD_FILE, so this must not
// land there.
if (process.env.KR_TLDR_SCHEMA_FILE && kind === 'tldr') {
  const i = process.argv.indexOf('--json-schema');
  appendFileSync(process.env.KR_TLDR_SCHEMA_FILE, process.argv[i + 1] ?? '');
}

// One fact, so the run reaches the tldr node — it is skipped entirely when the
// merge keeps nothing, and the schema recorded above is the point of this
// fixture. Unique URL so the known_urls drop can't remove it on a re-run.
respond({
  facts: (section) =>
    section !== 'news'
      ? []
      : [
          {
            section: 'news',
            text: 'Runner Test Co was created as a fixture for the runner lifecycle tests.',
            fact_date: '2026-07-15',
            group_key: null,
            importance: 5,
            stats: null,
            sources: [
              {
                publisher: 'Test Wire',
                title: 'Runner Test Co fixture announcement',
                url: `https://runner-test.example/news/record-${process.pid}-${Date.now()}`,
                year: 2026,
              },
            ],
          },
        ],
});
