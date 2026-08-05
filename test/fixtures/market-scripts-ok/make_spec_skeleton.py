// Fixture stand-in for web/market-assessment/scripts/make_spec_skeleton.py —
// a Node script under a .py name so tests can point PYTHON_BIN at
// process.execPath and MARKET_SCRIPTS_DIR at this directory, matching
// production's exact contract (index.mjs invokes a script literally named
// make_spec_skeleton.py via lib/run-python.mjs). CommonJS on purpose (plain
// `require`, no `import`): the package.json sitting next to this file
// ({"type":"commonjs"}) overrides the runner package's own {"type":"module"}
// for this subtree — without it, Node's ESM loader claims any unrecognized
// extension (including .py) as the nearest ancestor package.json's type
// dictates, and throws ERR_UNKNOWN_FILE_EXTENSION before ever reading this
// file's content (verified in this sandbox: identical file, identical repo,
// only the nested package.json differs). No shebang/chmod needed either,
// since this is always invoked as an argument to `node`, never executed
// directly.
const fs = require('node:fs');

const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const outPath = args[outIdx + 1];

// A trimmed but structurally real skeleton: every key the real
// make_spec_skeleton.py's build_skeleton() emits (tokens/per_slide/charts/
// logos), just fewer of each — enough for runMarketGenerateJob's merge logic
// to be exercised without hand-copying all ~266 real template tokens.
const skeleton = {
  tokens: {
    MARKET_NAME: '', GEOGRAPHY: '', CUSTOMER_ORG_TYPE: '',
    CATEGORY_1_NAME: '', CATEGORY_2_NAME: '', CATEGORY_3_NAME: '',
    MARKET_DEFINITION_QUOTE: '', EXEC_MARKET_DEFINITION: '', MARKET_ACTIVITY_TAKEAWAY: '',
    ECOSYSTEM_TIER_1_NAME: '', ECOSYSTEM_TIER_2_NAME: '', ECOSYSTEM_TIER_3_NAME: '', ECOSYSTEM_TIER_4_NAME: '',
    OPPORTUNITY_1_NAME: '', OPPORTUNITY_2_NAME: '', OPPORTUNITY_3_NAME: '', OPPORTUNITY_4_NAME: '', OPPORTUNITY_5_NAME: '',
    ACQUISITION_1_ACQUIRER: '', ACQUISITION_1_TARGET: '', DATE_1: '', THEME_1: '',
    YEAR_1: '', YEAR_2: '', YEAR_3: '', YEAR_4: '', YEAR_5: '', YEAR_6: '', YEAR_7: '',
  },
  per_slide: {
    3: { SOURCE_CITATIONS: '' },
    5: { SOURCE_CITATIONS: '' },
    6: { SOURCE_CITATIONS: '' },
    8: { SOURCE_CITATIONS: '' },
    9: { SOURCE_CITATIONS: '' },
    12: { SOURCE_CITATIONS: '' },
  },
  charts: {
    market_size: { years: [], series: { CATEGORY_1_NAME: [], CATEGORY_2_NAME: [], CATEGORY_3_NAME: [] } },
    market_share: { P1: null, P2: null, P3: null, P4: null, OTHER: null },
  },
  logos: { manifest: 'logos/manifest.json', tier1: [], tier2: [], tier3: [], tier4: [] },
};

fs.writeFileSync(outPath, JSON.stringify(skeleton));
console.log(`wrote ${outPath}`);
