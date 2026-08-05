// Fixture stand-in for web/market-assessment/scripts/fill_deck.py — see
// make_spec_skeleton.py in this directory for why this is CommonJS under a
// .py name. Sanity-checks spec.json parses (a real bug here — bad JSON from
// the assembly step — must still surface loudly), then writes a dummy file
// to -o, standing in for the built .pptx that index.mjs uploads to Storage.
const fs = require('node:fs');

const args = process.argv.slice(2);
const specPath = args[0];
JSON.parse(fs.readFileSync(specPath, 'utf8'));
const outIdx = args.indexOf('-o');
const outPath = args[outIdx + 1];
fs.writeFileSync(outPath, 'FAKE PPTX BYTES');
console.log(`OK: wrote ${outPath}`);
