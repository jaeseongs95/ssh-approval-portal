import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets } from '../src/adapters/config/secrets.mjs';
test('Compose secret files bind into server settings without shell evaluation or public payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-secrets-')); const file = join(root, 'secrets');
  try {
    await writeFile(file, '# comment\nBRIDGE_ADMIN_TOKEN="synthetic-only"\nBRIDGE_UI_ENABLED=false\nSSH_MCP_AWS_LOCAL_PASSPHRASE=synthetic-passphrase\n');
    const settings = await loadSecrets({ BRIDGE_SECRET_ENV_FILE: file });
    assert.equal(settings.BRIDGE_ADMIN_TOKEN, 'synthetic-only'); assert.equal(settings.BRIDGE_UI_ENABLED, 'false');
    await writeFile(file, 'NODE_OPTIONS=--inspect\n'); await assert.rejects(loadSecrets({}, file));
  } finally { await rm(root, { recursive: true }); }
});
