#!/usr/bin/env node
// Fake `claude` binary for lifecycle tests: ignores argv entirely and prints
// a `claude -p --output-format json` shaped payload whose last array element
// carries a schema-conformant structured_output for 'Runner Test Co' — see
// plugins/company-preview/references/output-schema.json for the required
// shape and test-run.sh for how the real CLI's output is parsed.
const structuredOutput = {
  newsroom_url: null,
  tldr: 'Runner Test Co is a fixture company used only by the runner lifecycle tests.',
  facts: [
    {
      section: 'news',
      text: 'Runner Test Co was created as a fixture for the runner lifecycle tests.',
      fact_date: '2026-07-15',
      group_key: null,
      sources: [
        {
          publisher: 'Test Wire',
          title: 'Runner Test Co fixture announcement',
          url: 'https://runner-test.example/news/fixture',
          year: 2026,
        },
      ],
    },
  ],
};

console.log(JSON.stringify([{ structured_output: structuredOutput }]));
