import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { loadSecrets } from '../src/adapters/config/secrets.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';

const settings = parseSettings(await loadSecrets(process.env, process.env.BRIDGE_TEST_ENV_FILE ?? process.env.BRIDGE_SECRET_ENV_FILE ?? '/etc/ssh-mcp-approval-bridge.env'));
const response = await fetch(`http://127.0.0.1:${settings.mcpPort}/health`, { signal: AbortSignal.timeout(3000) });
assert.equal(response.status, 200);
assert.equal((await response.json()).maintenance, false);
if (process.argv.includes('--node-license')) assert.ok((await stat('/usr/share/licenses/node/LICENSE')).size > 1000);
console.log('Synthetic runtime health and maintenance state confirmed');
