// Shared dispatcher for the fake `claude` binaries used by market-lifecycle
// tests. Reuses fake-claude-lib.mjs's prompt parsing as-is: promptArg/nodeKind
// key off `sections=<slug>` and the verify-gate prompt's opening line, both of
// which are identical whether the caller is /company-preview or
// /market-jumpstart (nodeKind has no skill-name check) — so no fork is needed
// for that part, only for the market-shaped scout/topic answers below.
import { promptArg, nodeKind, emit } from './fake-claude-lib.mjs';

export { promptArg, nodeKind, emit };

export const MARKET_SCOUT_OK = {
  scope_ok: true,
  canonical_market: 'Denials Management',
  geography: 'US',
  parent_market: 'Revenue Cycle Management',
  includes: 'Identifying, appealing, and preventing denied insurance claims.',
  excludes: 'Broader RCM functions like eligibility verification and coding.',
  categories: ['Denial Prevention', 'Denial Identification', 'Appeals Management'],
  customer_org_type: 'provider organizations',
  coverage_outlook: 'thin',
  context_brief: 'Fixture market used only by the runner market-lifecycle tests.',
  clarifying_question: null,
  stop_reason: null,
};

export const MARKET_SCOUT_SCOPE_QUESTION = {
  scope_ok: false,
  canonical_market: 'Revenue Cycle Management',
  geography: 'US',
  parent_market: null,
  includes: '',
  excludes: '',
  categories: ['a', 'b', 'c'],
  customer_org_type: 'provider organizations',
  coverage_outlook: 'thin',
  context_brief: null,
  clarifying_question: 'All of revenue cycle management, or just denials management?',
  stop_reason: 'STOP: the named market spans two markets that would need separate assessments.',
};

// Answers every node a fixture doesn't care about. Defaults are boring: the
// scout passes its scope check, the skeptic keeps everything (so a fixture
// never loses a fact to a gate it isn't testing).
export function respondMarket({ facts = () => [], scout = MARKET_SCOUT_OK } = {}) {
  const kind = nodeKind(promptArg());
  if (kind === 'scout') return emit(scout);
  if (kind.startsWith('topic:')) {
    const section = kind.slice('topic:'.length);
    return emit({ section, facts: facts(section), coverage_note: null, notes: null });
  }
  if (kind === 'verify') return emit({ keep: true, reason: 'fixture keeps everything', downgrade: false });
  return emit({});
}
