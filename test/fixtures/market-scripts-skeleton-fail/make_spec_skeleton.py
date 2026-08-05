// Fixture stand-in for a broken make_spec_skeleton.py (e.g. a bad --template
// path) — deliberate non-zero exit so runMarketGenerateJob's loud-failure
// path is exercised. fetch_logos.py/fill_deck.py deliberately don't exist in
// this directory: the job must throw right after this call, before either
// would ever be invoked.
console.error('fake make_spec_skeleton: deliberate failure (bad template)');
process.exit(2);
