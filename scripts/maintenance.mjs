import { loadSecrets } from '../secrets.mjs';
const action = process.argv[2];
if (!['reserve', 'release'].includes(action)) throw Error('Expected reserve or release');
const settings = await loadSecrets(process.env, process.env.BRIDGE_SECRET_ENV_FILE ?? '/etc/ssh-mcp-approval-bridge.env');
const token = settings.BRIDGE_ADMIN_TOKEN, origin = settings.BRIDGE_ADMIN_ORIGIN;
if (!token || !origin) throw Error('Missing administrator configuration');
try {
  const response = await fetch('http://127.0.0.1:39125/api/maintenance/' + action, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: origin }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error('Maintenance refused');
  const body = await response.json();
  if (body[action === 'reserve' ? 'reserved' : 'released'] !== true) throw Error('Unsupported maintenance API');
  console.log('Maintenance ' + action + ' confirmed');
} catch {
  console.error('Maintenance refused. Finish/deny jobs and transfers first. For a legacy 0.2 server, stop its service in the administrator terminal before updating.');
  process.exitCode = 1;
}
