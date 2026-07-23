#!/usr/bin/env node
// Fake `claude` binary for lifecycle tests: the scout passes, then EVERY topic
// node emits a well-formed envelope (passes checkShape) whose fact has an
// EMPTY sources array — the exact nested-source violation checkFacts() exists
// to catch before any DB write (codex review: facts insert first, so a
// malformed source found mid-write would strand already-inserted facts).
//
// All six sections failing the gate is a total loss, not a partial, so the job
// fails — see index.mjs's "every topic node failed". A SINGLE bad section
// would instead be contained and reported as a partial (spec §10).
import { respond } from './fake-claude-lib.mjs';

respond({
  facts: (section) => [
    {
      section,
      text: 'This fact has no sources and must never reach the DB.',
      fact_date: '2026-07-15',
      group_key: null,
      importance: 5,
      stats: null,
      sources: [],
    },
  ],
});
