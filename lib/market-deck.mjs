// Deck-spec assembly — the CODE edge between approved market facts and the
// .pptx (spec §7.2: "no model call touches a number"). Pure, zero I/O, zero
// model calls: charts and the deal timeline are built by reading `stats`
// straight off already-reviewed facts, matching the shape
// `make_spec_skeleton.py`'s build_skeleton() emits and `fill_deck.py`
// consumes (web/market-assessment/scripts). Token names are the ground-truth
// contract in scripts/sample/make_sample_spec.py — read that file before
// touching a key name here.
//
// Lives outside index.mjs for the same reason lib/topic-graph.mjs does: it
// needs to be importable by a test without triggering index.mjs's sign-in.

// The three category series slots the template's slide-6 chart has (spec §4
// `markets.categories`, exactly 3, the shared vocabulary every section
// reuses verbatim). A tam fact's stats.segment must equal one of these
// strings (by position) to land in a series — an unrecognized segment (a
// stray value, or null for a whole-market total with no per-category break)
// has no slot and is silently excluded, which is correct: better an absent
// series than a guessed one.
function categorySlot(segment, categories) {
  const i = categories.indexOf(segment);
  return i === -1 ? null : i;
}

// `facts` -> approved market_size facts (stats.type === 'tam'). `categories`
// -> the market row's 3 canonical category names, in order, so a fact's
// stats.segment can be placed in the matching CATEGORY_N_NAME series.
//
// A series with fewer than 2 cited years is omitted entirely (spec §7.2: "a
// series with fewer than two cited points is omitted ... the chart is
// allowed to be thin"), never padded or interpolated to look complete.
export function buildMarketSizeChart(facts, categories = []) {
  const bySlot = categories.map(() => new Map()); // slot idx -> year -> value

  for (const fact of facts ?? []) {
    const s = fact?.stats;
    if (!s || s.type !== 'tam' || s.year == null || typeof s.value !== 'number') continue;
    const slot = categorySlot(s.segment, categories);
    if (slot == null) continue;
    // First-cited value for a given year wins. Two sections independently
    // citing a different figure for the same category+year is a real
    // disagreement (the merge guard, spec §5, keeps both facts on file for
    // human review) — this chart just can't show two lines for one slot, so
    // it takes whichever arrived first rather than silently averaging or
    // preferring "last write wins".
    if (!bySlot[slot].has(s.year)) bySlot[slot].set(s.year, s.value);
  }

  const survivors = bySlot
    .map((years, i) => ({ i, years }))
    .filter(({ years }) => years.size >= 2);

  if (survivors.length === 0) return { years: [], series: {} };

  const years = [...new Set(survivors.flatMap(({ years: y }) => [...y.keys()]))].sort((a, b) => a - b);
  const series = {};
  for (const { i, years: y } of survivors) {
    // ponytail: when categories cite different year sets, a survivor missing
    // one of the union's years gets `null` here rather than an interpolated
    // guess. fill_deck.py's chart validation can't take a null value today —
    // ragged year coverage across categories is the open design risk spec
    // §12 #1 flags ("decide before the first real run"), not solved here.
    series[`CATEGORY_${i + 1}_NAME`] = years.map((y2) => y.get(y2) ?? null);
  }
  return { years, series };
}

// `facts` -> approved vendors facts (stats.type === 'share'). Returns the
// top 4 named players by share_pct plus a residual OTHER bucket summing to
// 100, or `null` when fewer than 2 players published a share — an empty
// chart is the correct output (spec §11: "no invented share splits"), never
// a guessed one.
export function buildMarketShareChart(facts) {
  const byPlayer = new Map(); // player -> share_pct, first-cited wins (same rule as the size chart)
  for (const fact of facts ?? []) {
    const s = fact?.stats;
    if (!s || s.type !== 'share' || !s.player || typeof s.share_pct !== 'number') continue;
    if (!byPlayer.has(s.player)) byPlayer.set(s.player, s.share_pct);
  }

  const ranked = [...byPlayer.values()].sort((a, b) => b - a);
  if (ranked.length < 2) return null;

  const top4 = ranked.slice(0, 4);
  const chart = {};
  top4.forEach((pct, i) => { chart[`P${i + 1}`] = pct; });
  const sum = top4.reduce((acc, pct) => acc + pct, 0);
  // OTHER is a residual (100 - the named top-4 total), not a cited figure —
  // the deck template already treats it as the "everyone else" slice, same
  // convention scripts/sample/make_sample_spec.py's fixture uses.
  chart.OTHER = Math.max(0, Math.round((100 - sum) * 100) / 100);
  return chart;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parsed manually (not via `new Date`) so a UTC-midnight ISO date can never
// shift a day into the wrong month under a negative timezone offset — the
// timeline only ever needs the month name and year, never a real instant.
function formatMonthYear(isoDate) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate ?? '');
  if (!m) return null;
  const [, year, month] = m;
  const idx = Number(month) - 1;
  if (idx < 0 || idx > 11) return null;
  return `${MONTH_ABBR[idx]} ${year}`;
}

// `facts` -> approved deals facts (stats.type === 'acquisition'). Emits
// ACQUISITION_i_ACQUIRER/ACQUISITION_i_TARGET/DATE_i for the up-to-10
// deals sorted by announced date (i = 1..N, never padded past what's real),
// plus YEAR_1..YEAR_7 for the trailing 7-year window the timeline is drawn
// against (deck-token-map.md §deals; `now` is injectable for tests).
//
// Deliberately does NOT emit THEME_i: a deal's `acquisition` stats
// (acquirer/target/deal_value/announced, per output-schema.json) carry no
// theme field — the "recurring consolidation themes" list is a separate
// per-slide-group prose call over the reviewed deals evidence (spec §7.3
// "deal themes"), not something code can read off a stat. That token is the
// generate job's (task 6) to fill, not this pure assembly step's.
export function buildDealTimelineTokens(facts, { now = new Date() } = {}) {
  const deals = (facts ?? [])
    .map((f) => f?.stats)
    .filter((s) => s && s.type === 'acquisition' && s.acquirer && s.target && formatMonthYear(s.announced))
    .sort((a, b) => a.announced.localeCompare(b.announced))
    .slice(0, 10);

  const tokens = {};
  deals.forEach((d, i) => {
    const n = i + 1;
    tokens[`ACQUISITION_${n}_ACQUIRER`] = d.acquirer;
    tokens[`ACQUISITION_${n}_TARGET`] = d.target;
    tokens[`DATE_${n}`] = formatMonthYear(d.announced);
  });

  const endYear = now.getFullYear();
  for (let i = 0; i < 7; i += 1) {
    tokens[`YEAR_${i + 1}`] = String(endYear - 6 + i);
  }
  return tokens;
}

// `marketRow` -> the markets table row written by the scout (task 5's job).
// Trivial field mapping, still worth its own tests: a wrong key name here
// silently blanks a slide token rather than erroring (the "empty slot is
// correct" assembly rule fails silent, not loud). MARKET_TRAJECTORY and the
// vendor-landscape sentence are deliberately NOT here — deck-token-map.md's
// "written by the assembly step, not by research" list makes those a
// synthesis job over reviewed facts (task 6), not a markets-row field.
export function buildVocabTokens(marketRow) {
  const categories = marketRow?.categories ?? [];
  const tokens = {
    MARKET_NAME: marketRow?.name ?? '',
    GEOGRAPHY: marketRow?.geography ?? '',
    CUSTOMER_ORG_TYPE: marketRow?.customer_org_type ?? '',
  };
  categories.slice(0, 3).forEach((name, i) => { tokens[`CATEGORY_${i + 1}_NAME`] = name; });
  return tokens;
}
