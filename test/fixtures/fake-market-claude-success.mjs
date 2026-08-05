#!/usr/bin/env node
// Fake `claude` binary for the market-lifecycle "full success" run: scout
// passes scope, one section (market_size) finds one well-sourced tam fact,
// the rest legitimately find nothing.
import { respondMarket } from './fake-market-claude-lib.mjs';

respondMarket({
  facts: (section) =>
    section !== 'market_size'
      ? []
      : [
          {
            section: 'market_size',
            text: 'US denials management TAM was $1.2B in 2025 per Fixture Research.',
            fact_date: '2026-01-15',
            group_key: 'tam-us-2025',
            importance: 9,
            stats: { type: 'tam', value: 1200000000, unit: 'usd', year: 2025, geography: 'US' },
            sources: [
              {
                publisher: 'Fixture Research',
                title: 'Denials Management Market Report',
                // Unique per invocation, same reason fake-claude-success.mjs's
                // URL is unique — a fixed URL would be suppressed as an
                // already-known source on every suite run after the first.
                url: `https://fixture-research.example/report-${process.pid}-${Date.now()}`,
                year: 2026,
              },
            ],
          },
        ],
});
