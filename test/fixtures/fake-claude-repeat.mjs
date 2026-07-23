#!/usr/bin/env node
// Identical to fake-claude-success.mjs except the source URL is FIXED — every
// invocation cites the same article, which is exactly what the repeat-
// suppression test needs: the second run must be deduped by the runner.
const structuredOutput = {
  newsroom_url: null,
  tldr: 'Runner Test Co is a fixture company used only by the runner lifecycle tests.',
  facts: [
    {
      section: 'news',
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
};

console.log(JSON.stringify([{ structured_output: structuredOutput }]));
