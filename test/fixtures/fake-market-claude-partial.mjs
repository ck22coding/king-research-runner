#!/usr/bin/env node
// Fake `claude` binary for the market-lifecycle "partial" run: the vendors
// topic node dies, the other eight are fine. Failure containment (spec
// §3.3) means the job must still land 'done' with the surviving sections'
// facts written, and must name what was lost.
import { respondMarket, nodeKind, promptArg } from './fake-market-claude-lib.mjs';

if (nodeKind(promptArg()) === 'topic:vendors') {
  process.stderr.write('fixture: market vendors node blew up\n');
  process.exit(1);
}

respondMarket({
  facts: (section) =>
    section !== 'market_size'
      ? []
      : [
          {
            section: 'market_size',
            text: 'US denials management TAM was $1.2B in 2025 per Fixture Research (vendors section failed this run).',
            fact_date: '2026-01-15',
            group_key: 'tam-us-2025',
            importance: 9,
            stats: { type: 'tam', value: 1200000000, unit: 'usd', year: 2025, geography: 'US' },
            sources: [
              {
                publisher: 'Fixture Research',
                title: 'Denials Management Market Report',
                url: `https://fixture-research.example/partial-${process.pid}-${Date.now()}`,
                year: 2026,
              },
            ],
          },
        ],
});
