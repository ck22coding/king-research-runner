#!/usr/bin/env node
// Identical to fake-claude-success.mjs except the source URL is FIXED — every
// invocation cites the same article, which is exactly what the repeat-
// suppression test needs: the second run must be deduped by the merge edge's
// known_urls drop (lib/topic-graph.mjs).
import { respond } from './fake-claude-lib.mjs';

respond({
  facts: (section) =>
    section !== 'growth_signals'
      ? []
      : [
          {
            section: 'growth_signals',
            text: 'Runner Test Co repeat-fixture story (same URL every run).',
            fact_date: '2026-07-15',
            group_key: null,
            importance: 5,
            stats: null,
            sources: [
              {
                publisher: 'Test Wire',
                title: 'Runner Test Co repeat fixture announcement',
                url: 'https://runner-test.example/news/repeat-fixture',
                year: 2026,
              },
            ],
          },
        ],
});
