#!/usr/bin/env node
// Fake `claude` binary for lifecycle tests: emits valid JSON that is missing
// structured_output (mirrors a CLI error / schema-refusal response). This
// must trip the same loud-failure shape check test-run.sh uses:
//   jq -e '(type == "array") and ((.[-1].structured_output? | type) == "object")'
console.log(JSON.stringify([{ result: 'I was unable to complete this research task.' }]));
