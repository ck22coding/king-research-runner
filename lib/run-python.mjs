// Generic subprocess wrapper for the three deck-build scripts the generate
// job invokes (make_spec_skeleton.py, fetch_logos.py, fill_deck.py) — same
// spawn/timeout/SIGTERM-then-SIGKILL/output-cap shape as index.mjs's
// runClaude, factored out once instead of copied three times.
//
// Separate from index.mjs (same reason lib/topic-graph.mjs is separate): it
// needs to be importable in isolation for a fast unit test, and index.mjs
// can't be imported without triggering sign-in.
import { spawn } from 'node:child_process';

// ponytail: fixed grace between SIGTERM and SIGKILL, no override — same
// "give it a moment to clean up" cushion as index.mjs's CLAUDE_KILL_GRACE_MS.
const KILL_GRACE_MS = 5000;
// A deck-build script's stdout/stderr is small (file paths, progress lines);
// this is a runaway-child backstop, not a tuned budget — same cap runClaude
// uses.
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Resolves (never rejects) {stdout, stderr, code, spawnError, timedOut,
// overflowed} — same shape runClaude resolves with, so the checkShape-style
// error handling around a generate job's calls (tasks 5/6) stays uniform
// across the claude leg and the three python legs.
export function runPython({ bin, args = [], cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, cwd ? { cwd } : {});
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let killTimer;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve(result);
    };
    const capped = (d) => {
      if (stdout.length + stderr.length + d.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill('SIGKILL');
        return false;
      }
      return true;
    };
    child.stdout.on('data', (d) => capped(d) && (stdout += d));
    child.stderr.on('data', (d) => capped(d) && (stderr += d));
    child.on('error', (spawnError) => finish({ stdout, stderr, code: null, spawnError, timedOut, overflowed }));
    child.on('close', (code) => finish({ stdout, stderr, code, spawnError: null, timedOut, overflowed }));
  });
}
