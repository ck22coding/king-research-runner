#!/usr/bin/env node
// Stand-in for a deck-build script (make_spec_skeleton.py / fetch_logos.py /
// fill_deck.py) on the happy path. Echoes argv + cwd as JSON so the wrapper
// test can assert both are forwarded correctly, and writes a stderr line too
// so stdout/stderr capture is exercised together. Exits 0.
console.error('fake-python-ok: a stderr line');
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
