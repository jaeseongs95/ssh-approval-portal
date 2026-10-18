import test from 'node:test';
import assert from 'node:assert/strict';
import { createVaultSecretStore } from '../src/adapters/secrets/vault-kv.mjs';
import { parseSettings, settingsContract } from '../src/adapters/config/settings.mjs';

test('Vault configuration pins HTTPS origin, flat mount and local-only token reference', () => {
  const env = { BRIDGE_MCP_TOKEN: 'mcp', BRIDGE_ADMIN_TOKEN: 'admin', BRIDGE_ADMIN_ORIGIN: 'https://admin.example.test' };
  const defaults = parseSettings(env);
  assert.equal(defaults.vaultOrigin, ''); assert.equal(defaults.vaultMount, 'secret'); assert.equal(defaults.vaultTokenRef, '');
  const valid = { ...env, BRIDGE_VAULT_URL: 'https://vault.example.test:8200', BRIDGE_VAULT_MOUNT: 'kv-2', BRIDGE_VAULT_TOKEN_REF: 'secret://local-file/vault-reader-token', BRIDGE_JEV_KEY_REF: 'secret://vault/model-safety-api-key' };
  assert.equal(parseSettings(valid).vaultMount, 'kv-2');
  for (const key of ['BRIDGE_VAULT_URL','BRIDGE_VAULT_MOUNT','BRIDGE_VAULT_TOKEN_REF']) assert.ok(settingsContract.allowedKeys.includes(key));
  for (const value of ['http://vault.example.test','https://vault.example.test/','https://user@vault.example.test','https://vault.example.test?token=x','https://vault.example.test:443']) assert.throws(() => parseSettings({ ...valid, BRIDGE_VAULT_URL: value }));
  for (const value of ['', '../secret','secret/data','secret%2fdata','a'.repeat(65),3]) assert.throws(() => parseSettings({ ...valid, BRIDGE_VAULT_MOUNT: value }));
  for (const value of ['secret://vault/token','secret://other/token','plain','secret://local-file/../token',3]) assert.throws(() => parseSettings({ ...valid, BRIDGE_VAULT_TOKEN_REF: value }));
});

test('Vault port rejects unsafe names, invalid tokens and mutations without connecting', async () => {
  let calls = 0;
  const store = createVaultSecretStore({ origin: 'https://127.0.0.1:1', getToken: async () => { calls++; return 'invalid\ntoken'; } });
  for (const name of ['../token','name/other','%2f','','a'.repeat(65),3,{toString:()=>'model-key'}]) await assert.rejects(store.read(name), { code:'invalid_reference', message:'Secret operation refused' });
  assert.equal(calls, 0);
  for (const value of [undefined,'','has space','ü','x'.repeat(4097)]) {
    const item = createVaultSecretStore({ origin:'https://127.0.0.1:1', getToken:async () => value });
    await assert.rejects(item.read('key'), { code:'credential_unavailable' });
  }
  const broken = createVaultSecretStore({ origin:'https://127.0.0.1:1', getToken:async () => { throw Error('synthetic-private-body'); } });
  await assert.rejects(broken.read('key'), error => error.message === 'Secret operation refused' && error.code === 'credential_unavailable' && !error.cause);
  await assert.rejects(store.put('key','value'), { code:'read_only' });
  await assert.rejects(store.remove('key'), { code:'read_only' });
});
