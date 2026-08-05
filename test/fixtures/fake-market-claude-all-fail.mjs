#!/usr/bin/env node
// Fake `claude` binary for the market-lifecycle "total loss" run: the scout
// passes scope, but EVERY topic node dies. Not a partial — a total loss, so
// the job must fail loudly and the market's status must be restored.
import { respondMarket, nodeKind, promptArg } from './fake-market-claude-lib.mjs';

if (nodeKind(promptArg()).startsWith('topic:')) {
  process.stderr.write('fixture: market topic node blew up\n');
  process.exit(1);
}

respondMarket({});
