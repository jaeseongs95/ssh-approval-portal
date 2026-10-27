import { loadSecrets } from '../src/adapters/config/secrets.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';
import { readFileSync } from 'node:fs';
const action = process.argv[2];
if (!['reserve', 'release', 'capture', 'compare'].includes(action)) throw Error('Expected reserve, release, capture or compare');
// Ownership is passed on stdin, never in arguments or logs.
const owner = readFileSync(0, 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(owner)) throw Error('Invalid maintenance owner');
const settings = await loadSecrets(process.env, process.env.BRIDGE_SECRET_ENV_FILE ?? '/etc/ssh-mcp-approval-bridge.env');
const { adminPort } = parseSettings(settings);
const token = settings.BRIDGE_ADMIN_TOKEN, origin = settings.BRIDGE_ADMIN_ORIGIN;
if (!token || !origin) throw Error('Missing administrator configuration');
try {
  const headers = { Authorization: 'Bearer ' + token, Origin: origin, 'X-Maintenance-Owner': owner };
  const post = route => fetch(`http://127.0.0.1:${adminPort}/api/maintenance/${route}`, {
    method: 'POST', headers, signal: AbortSignal.timeout(5000),
  });
  const capability = await post('capabilities');
  if (!capability.ok || (await capability.json()).ownership !== 'durable-v1') throw Error('Unsupported maintenance API');
  const response = await post(['capture', 'compare'].includes(action) ? 'preservation/' + action : action);
  if (!response.ok) throw Error('Maintenance refused');
  const body = await response.json();
  const valid = action === 'compare' ? body.status === 'PASS' : body[{ reserve: 'reserved', release: 'released', capture: 'captured' }[action]] === true;
  if (body.ownership !== 'durable-v1' || !valid) throw Error('Maintenance request did not pass');
  console.log('Maintenance ' + action + ' confirmed');
} catch {
  console.error('Maintenance refused or response unknown. Retain the owner token for recovery; check the current service and reservation before retrying. Legacy services require a separately controlled offline update.');
  process.exitCode = 1;
}
