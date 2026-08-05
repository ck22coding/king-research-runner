// Shared dispatcher for the fake `claude` binaries.
//
// Before the topic graph, one enrich job meant one child call, so a fixture
// could print one blob and be done. The diamond makes ~9 calls per job (scout,
// six topic nodes, skeptics, tldr, ranking), so a fixture has to answer
// whichever node is on the line. Each fixture supplies only the part it is
// actually testing — the rest get harmless defaults from here.

// The prompt is the argument after -p (index.mjs spawns with an args array,
// never a shell string, so this is exact).
export function promptArg() {
  const i = process.argv.indexOf('-p');
  return i === -1 ? '' : process.argv[i + 1] ?? '';
}

// Which node is calling. Keyed off the same prompt text index.mjs builds, so
// if a node's prompt changes shape the fixtures fail loudly rather than
// silently answering the wrong node.
export function nodeKind(prompt) {
  if (/\bsections=scout\b/.test(prompt)) return 'scout';
  const section = prompt.match(/\bsections=([a-z_]+)/);
  if (section) return `topic:${section[1]}`;
  if (/^You are fact-checking ONE research claim/m.test(prompt)) return 'verify';
  if (/^Write the TL;DR/m.test(prompt)) return 'tldr';
  if (/^You are ranking research facts/m.test(prompt)) return 'rank';
  if (/^You are writing the sections of a 2-page company brief/m.test(prompt)) return 'synth';
  return 'unknown';
}

export function emit(structuredOutput) {
  console.log(JSON.stringify([{ structured_output: structuredOutput }]));
}

export const SCOUT_OK = {
  identity_ok: true,
  canonical_name: 'Runner Test Co',
  domain: 'runner-test.example',
  newsroom_url: null,
  company_type: 'private',
  context_brief: 'Fixture company used only by the runner tests.',
  stop_reason: null,
};

// Answers every node a fixture doesn't care about, and routes topic calls to
// the caller's `facts(section)`. Defaults are deliberately boring: the scout
// passes its identity check, the skeptic keeps everything (so a fixture never
// loses a fact to a gate it wasn't testing), and ranking returns an empty
// object — the ranking pass treats that as malformed, logs, and keeps date
// order, which is its documented best-effort behaviour.
export function respond({ facts = () => [], scout = SCOUT_OK, tldr = 'Runner Test Co is a fixture company used only by the runner lifecycle tests.' } = {}) {
  const kind = nodeKind(promptArg());
  if (kind === 'scout') return emit(scout);
  if (kind.startsWith('topic:')) {
    const section = kind.slice('topic:'.length);
    return emit({ section, facts: facts(section), notes: null });
  }
  if (kind === 'verify') return emit({ keep: true, reason: 'fixture keeps everything', downgrade: false });
  if (kind === 'tldr') return emit({ tldr });
  if (kind === 'synth') {
    // Generic regardless of which sections have facts: read the schema this
    // call was actually spawned with and answer exactly the keys it
    // requires, one placeholder paragraph each, rather than a fixed section
    // list that would drift from SECTION_SYNTH_QUESTIONS.
    const i = process.argv.indexOf('--json-schema');
    const required = i === -1 ? [] : JSON.parse(process.argv[i + 1] ?? '{}').required ?? [];
    return emit(Object.fromEntries(required.map((key) => [key, [`Placeholder paragraph for ${key}.`]])));
  }
  return emit({});
}
