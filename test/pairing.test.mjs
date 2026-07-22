import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnRunner, signInTestUser, writeCredsFor } from './helpers.mjs';

test('runner starts from a stored refresh token (no password vars)', async () => {
  const session = await signInTestUser();          // password sign-in, test-only
  const dir = mkdtempSync(join(tmpdir(), 'kr-'));
  const credPath = join(dir, 'credentials.json');
  writeCredsFor(session, credPath);

  const child = spawnRunner({
    env: { KR_CREDENTIALS_PATH: credPath, RUNNER_EMAIL: '', RUNNER_PASSWORD: '' },
  });
  const line = await child.waitForLine(/signed in as /, 15_000);
  assert.match(line, /signed in as .+@/);
  child.kill();
});

test('runner exits loudly with bad credentials and no TTY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-'));
  const credPath = join(dir, 'credentials.json');
  writeFileSync(credPath, JSON.stringify({ refresh_token: 'garbage' }));

  const child = spawnRunner({ env: { KR_CREDENTIALS_PATH: credPath } });
  const code = await child.waitForExit(15_000);
  assert.equal(code, 1);
  assert.match(child.stderr(), /re-pair this computer/i);
});
