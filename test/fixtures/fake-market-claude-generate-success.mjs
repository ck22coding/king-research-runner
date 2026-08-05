#!/usr/bin/env node
// Fake `claude` binary for the market-generate "full success" run: answers
// the ranking pass (malformed-tolerant default — see respondMarketGenerate)
// plus all four bounded prose-token calls with real, deterministic values.
import { respondMarketGenerate } from './fake-market-claude-lib.mjs';

respondMarketGenerate({
  definition: {
    MARKET_DEFINITION_QUOTE: 'A quoted fixture definition.',
    EXEC_MARKET_DEFINITION: 'Fixture exec definition.',
  },
  dealThemes: {
    MARKET_ACTIVITY_TAKEAWAY: 'Consolidation continues (fixture).',
    THEME_1: 'PE roll-ups',
  },
  ecosystem: {
    ECOSYSTEM_TIER_1_NAME: 'Regulators',
    ECOSYSTEM_TIER_2_NAME: 'Associations',
    ECOSYSTEM_TIER_3_NAME: 'End Users',
    ECOSYSTEM_TIER_4_NAME: 'Vendors',
  },
  opportunities: { opportunities: ['Automation'] },
});
