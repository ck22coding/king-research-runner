#!/usr/bin/env node
// Fake `claude` binary for lifecycle tests. Since the topic graph, one job is
// ~9 child calls rather than one, so the fixture answers per node (see
// fake-claude-lib.mjs): the scout passes its identity check, one section
// returns one well-formed fact, the other five legitimately find nothing.
import { respond } from './fake-claude-lib.mjs';

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
                // Unique per invocation: test cleanup rejects facts but can't
                // delete them (no DELETE policy), and rejected sources count as
                // dedup history — a fixed URL here would get suppressed on every
                // suite run after the first. Fixed-URL repeat behavior is
                // covered by fake-claude-repeat.mjs instead.
                url: `https://runner-test.example/news/fixture-${process.pid}-${Date.now()}`,
                year: 2026,
              },
            ],
          },
        ],
});
