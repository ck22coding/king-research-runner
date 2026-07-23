// Pure helpers for the topic-graph ("diamond") enrichment edge — the code
// that runs BETWEEN the claude -p nodes. Zero tokens, zero I/O, no DB: the
// merge is deterministic JavaScript on purpose (spec §7), so cross-section
// dedup is free and reliable instead of something a model has to hold in
// its head.
//
// Lives in its own module rather than inside index.mjs solely so it can be
// imported by a test — index.mjs signs in and starts a daemon at import time.

// Per-section freshness windows. Shared: the PDF renderer gates on these at
// render time (web lib/pdf/report.ts), the ranking/synthesis passes bucket by
// them, and the verify gate uses them to spot near-edge dates. Keep in sync
// with REPORT_SECTIONS in web/lib/pdf/report.ts.
export const SECTION_WINDOWS_MONTHS = {
  leadership: 6,
  acquisitions_partnerships: 12,
  news: 6,
  financials: 12,
  growth_signals: 3,
  risk_flags: 6,
};

// Dedup key for suggested-source URLs: lowercase host minus www., path minus
// trailing slashes; protocol/query/fragment dropped (tracking params, http vs
// https). Known gap: a story resurfacing under a genuinely different URL is
// NOT caught by URL matching alone — which is exactly why mergeTopicFacts
// also matches on group_key.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${pathname}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

// Merge edge (spec §7). Flattens every topic node's facts into one list,
// collapsing facts that describe the same underlying story, then applies the
// known_urls drop.
//
// Two facts are the same story when EITHER their group_key matches (both
// non-null) OR they share a source URL. Both keys are needed: sections run in
// separate processes that never see each other's output, so they routinely
// slug one story two different ways (group_key misses, URL catches it), and
// just as routinely cite two different articles about it (URL misses,
// group_key catches it).
//
// Merging is first-wins with the better field kept: sources are unioned
// (deduped by normalized URL), importance takes the max — a story one section
// rated a 9 is a 9 — and a null fact_date/stats/group_key is filled in from
// the later fact rather than staying null.
//
// KNOWN RISK, per spec §7 and its own §15 "watch for misses": URL overlap
// merges on a shared source ALONE, even when both facts named different
// group_keys. That is what catches one story slugged two ways, but it also
// means two genuinely different claims that happen to cite one document (a
// 10-Q supporting both a financials and a risk_flags fact) collapse into one,
// and the loser's text is dropped. Every absorb is returned in `absorbed` so
// the runner can log both texts — a wrong merge stays diagnosable rather than
// silent. Tightening the rule is a spec decision, not a code one.
//
// `knownNormalized` is the set of every source URL ever suggested for this
// company. A fact citing ANY of them is dropped whole: per SKILL.md's sourcing
// rules every source must be the specific supporting article, so one match
// means this is a story already on file. (Spec §7 phrases this as "only
// sources" — the shipped runner rule is ANY, which is the stricter and
// less repetitive of the two, so it stays as-is.) The drop runs AFTER the
// merge on purpose: a story already known under one URL but freshly covered
// under another must still read as a repeat, not as a new find.
export function mergeTopicFacts(topicResults, knownNormalized = new Set()) {
  const groups = []; // { fact, urls: Set<normUrl> }
  const byGroupKey = new Map(); // group_key -> a group index (resolve via find)
  const byUrl = new Map(); // normUrl -> a group index (resolve via find)
  const absorbed = []; // [survivingText, absorbedText] — logged by the caller

  // Union-find. Grouping has to be TRANSITIVE: a fact can connect two groups
  // that had nothing in common until it arrived (A is k1/u1, B is k2/u2, and
  // C arrives carrying k1 AND u2 — all one story). Picking a single match and
  // ignoring the rest leaves the story split across two facts, which is the
  // exact duplicate this edge exists to remove. Path-compressed find keeps
  // the map entries valid without ever rewriting them.
  const parent = [];
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  // Fold group b into group a: union the sources, keep the better field.
  const absorb = (a, b) => {
    const keep = groups[a];
    const gone = groups[b];
    for (const s of gone.fact.sources) {
      const u = normalizeUrl(s.url);
      if (!keep.urls.has(u)) {
        keep.urls.add(u);
        keep.fact.sources.push(s);
      }
    }
    keep.fact.importance = Math.max(keep.fact.importance ?? 0, gone.fact.importance ?? 0);
    keep.fact.fact_date ??= gone.fact.fact_date;
    keep.fact.stats ??= gone.fact.stats;
    keep.fact.group_key ??= gone.fact.group_key;
    absorbed.push([keep.fact.text, gone.fact.text]);
    parent[b] = a;
    gone.dead = true;
  };

  for (const result of topicResults) {
    for (const fact of result?.facts ?? []) {
      const normUrls = (fact.sources ?? []).map((s) => normalizeUrl(s.url));
      const key = fact.group_key || null;

      // Every group this fact touches, by EITHER key.
      const hits = new Set();
      if (key != null && byGroupKey.has(key)) hits.add(find(byGroupKey.get(key)));
      for (const u of normUrls) {
        if (byUrl.has(u)) hits.add(find(byUrl.get(u)));
      }

      let idx;
      if (hits.size === 0) {
        idx = groups.length;
        parent[idx] = idx;
        // Copy with empty sources: the union loop below fills them in, so a
        // fact citing one URL twice is deduped on the same path a
        // cross-section merge is. Never mutate a node's output in place.
        groups.push({ fact: { ...fact, sources: [] }, urls: new Set(), dead: false });
      } else {
        // Lowest index wins so the earliest-seen fact keeps its text/section;
        // everything else it turned out to be connected to folds into it.
        const ordered = [...hits].sort((a, b) => a - b);
        idx = ordered[0];
        for (const other of ordered.slice(1)) absorb(idx, other);
        const g = groups[idx];
        g.fact.importance = Math.max(g.fact.importance ?? 0, fact.importance ?? 0);
        g.fact.fact_date ??= fact.fact_date;
        g.fact.stats ??= fact.stats;
        g.fact.group_key ??= fact.group_key;
        absorbed.push([g.fact.text, fact.text]);
      }

      const g = groups[idx];
      for (const s of fact.sources ?? []) {
        const u = normalizeUrl(s.url);
        if (!g.urls.has(u)) {
          g.urls.add(u);
          g.fact.sources.push(s);
        }
        if (!byUrl.has(u)) byUrl.set(u, idx);
      }
      if (key != null && !byGroupKey.has(key)) byGroupKey.set(key, idx);
      if (g.fact.group_key != null && !byGroupKey.has(g.fact.group_key)) byGroupKey.set(g.fact.group_key, idx);
    }
  }

  const facts = [];
  let droppedKnown = 0;
  for (const g of groups) {
    if (g.dead) continue;
    if ([...g.urls].some((u) => knownNormalized.has(u))) { droppedKnown += 1; continue; }
    facts.push(g.fact);
  }
  return { facts, mergedCount: absorbed.length, droppedKnown, absorbed };
}

// Verify gate's targeting rule (spec §8). Facts are already source-cited, so
// blanket verification is waste — only these four shapes get a skeptic:
// unsupported-by-a-second-source, private-company financial estimates, things
// the text itself calls a rumor, and dates sitting on the edge of the
// section's freshness window (where a small date error decides inclusion).
// Returns a short reason string (for the log + the skeptic's prompt), or null
// when the fact is not worth a call.
// ponytail: 14 days of edge, one flat number for every section — widen it if
// near-edge facts start slipping through review.
const WINDOW_EDGE_DAYS = 14;

export function riskyReason(fact, { companyType, now = new Date() } = {}) {
  if ((fact.sources ?? []).length < 2) return 'single-source';
  if (companyType === 'private' && fact.section === 'financials') return 'private-company financial estimate';
  if (/\brumou?r/i.test(fact.text ?? '')) return 'rumor-labeled';
  const months = SECTION_WINDOWS_MONTHS[fact.section];
  if (months != null && fact.fact_date) {
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);
    const edge = new Date(cutoff);
    edge.setDate(edge.getDate() + WINDOW_EDGE_DAYS);
    const d = fact.fact_date;
    if (d >= cutoff.toISOString().slice(0, 10) && d <= edge.toISOString().slice(0, 10)) {
      return 'fact_date near the edge of the section window';
    }
  }
  return null;
}
