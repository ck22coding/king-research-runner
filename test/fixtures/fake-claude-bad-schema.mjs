#!/usr/bin/env node
// Fake `claude` binary for lifecycle tests: emits a well-formed
// `claude -p --output-format json` envelope (passes checkShape) whose fact
// has an EMPTY sources array — the exact nested-source violation
// checkAgainstSchema() exists to catch before any DB write (codex review:
// facts insert first, so a malformed source found mid-write would strand
// already-inserted facts).
const structuredOutput = {
  newsroom_url: null,
  tldr: 'Runner Test Co fixture output with a sourceless fact.',
  facts: [
    {
      section: 'news',
      text: 'This fact has no sources and must never reach the DB.',
      fact_date: '2026-07-15',
      group_key: null,
      sources: [],
    },
  ],
};

console.log(JSON.stringify([{ structured_output: structuredOutput }]));
