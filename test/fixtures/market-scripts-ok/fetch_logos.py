// Fixture stand-in for web/market-assessment/scripts/fetch_logos.py — see
// make_spec_skeleton.py in this directory for why this is CommonJS under a
// .py name. Never actually fetches anything: writes a manifest.json marking
// every company "source: none" (real fetch_logos.py's own no-hit outcome),
// which is all runMarketGenerateJob needs — it builds spec.logos.tierN from
// the fact stats directly, not from this manifest (only fill_deck.py, the
// real python script, reads it).
const fs = require('node:fs');

const [companiesPath, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const companies = JSON.parse(fs.readFileSync(companiesPath, 'utf8'));
const manifest = {
  companies: companies.map((c) => ({ name: c.name, slug: c.name.toLowerCase(), source: 'none' })),
  failures: companies.map((c) => c.name),
};
fs.writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest));
console.log(`fake fetch_logos: wrote ${outDir}/manifest.json`);
