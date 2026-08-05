#!/usr/bin/env node
// Fake `claude` binary for the market-lifecycle "scope question" run: the
// scout stops with scope_ok:false. No topic node should ever be invoked for
// this — if the runner has a bug and calls one anyway, respondMarket's
// default (empty facts) keeps this from blowing up either way.
import { respondMarket, MARKET_SCOUT_SCOPE_QUESTION } from './fake-market-claude-lib.mjs';

respondMarket({ scout: MARKET_SCOUT_SCOPE_QUESTION });
