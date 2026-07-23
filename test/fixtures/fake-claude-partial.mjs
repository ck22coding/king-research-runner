#!/usr/bin/env node
// One topic node dies; the other five are fine. Failure containment (spec §10)
// means the job must still land 'done' with the surviving sections' facts
// written — a five-section report beats no report — and must say so.
import { respond, nodeKind, promptArg } from './fake-claude-lib.mjs';

if (nodeKind(promptArg()) === 'topic:financials') {
  process.stderr.write('fixture: financials node blew up\n');
  process.exit(1);
}

respond({
  facts: (section) =>
    section !== 'news'
      ? []
      : [
          {
            section: 'news',
            text: 'Runner Test Co partial-fixture story (financials failed this run).',
            fact_date: '2026-07-15',
            group_key: null,
            importance: 5,
            stats: null,
            sources: [
              {
                publisher: 'Test Wire',
                title: 'Runner Test Co partial fixture announcement',
                url: `https://runner-test.example/news/partial-${process.pid}-${Date.now()}`,
                year: 2026,
              },
            ],
          },
        ],
});
