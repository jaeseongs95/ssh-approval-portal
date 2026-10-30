import { loadSecrets } from '../src/adapters/config/secrets.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';
import { readFileSync } from 'node:fs';
import { BASELINE_PRESERVATION_CONTRACT, PRESERVATION_COUNTERS, baselinePreservationAccepted } from '../src/adapters/storage/preservation-verification.mjs';
const action = process.argv[2];
if (!['reserve', 'release', 'release-verified', 'release-baseline-verified', 'capture', 'compare', 'compare-baseline', 'status'].includes(action)) throw Error('Invalid maintenance action');
const baselineMode = ['compare-baseline', 'release-baseline-verified'].includes(action);
const comparing = ['compare', 'compare-baseline'].includes(action);
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
  const supported = capability.ok && await capability.json();
  if (supported?.ownership !== 'durable-v1' || baselineMode && supported.baselineComparison !== BASELINE_PRESERVATION_CONTRACT) throw Error('Unsupported maintenance API');
  if (['release-verified', 'release-baseline-verified'].includes(action)) headers['X-Maintenance-Compare-Required'] = '1';
  if (baselineMode) headers['X-Maintenance-Preservation-Contract'] = BASELINE_PRESERVATION_CONTRACT;
  const response = await post(comparing ? 'preservation/compare' : action === 'capture' ? 'preservation/capture' : ['release-verified', 'release-baseline-verified'].includes(action) ? 'release' : action);
  if (!response.ok) throw Error('Maintenance refused');
  const body = await response.json();
  if (body.ownership !== 'durable-v1') throw Error('Unsupported maintenance API');
  if (action === 'status') { if (!['reserved', 'released', 'unknown'].includes(body.status)) throw Error('Invalid maintenance status'); console.log(body.status); process.exit(0); }
  if (comparing) {
    const keys = PRESERVATION_COUNTERS;
    if (keys.some(key => !Number.isSafeInteger(body[key]) || body[key] < 0)) throw Error('Invalid preservation summary');
    if (body.outputsUnavailable || body.expiredOutputsRemoved) console.error('Some output payloads were unavailable or expired; complete payload preservation was not verified.');
  }
  const valid = comparing ? baselineMode ? baselinePreservationAccepted(body) : body.status === 'PASS' && body.outputsUnavailable === 0 && body.expiredOutputsRemoved === 0
    : body[{ reserve: 'reserved', release: 'released', 'release-verified': 'released', 'release-baseline-verified': 'released', capture: 'captured' }[action]] === true
      && (!baselineMode || body.comparisonContract === BASELINE_PRESERVATION_CONTRACT);
  if (!valid) throw Error('Maintenance request did not pass');
  if (comparing) {
    const summary = Object.fromEntries(PRESERVATION_COUNTERS.map(key => [key, body[key]]));
    if (baselineMode) Object.assign(summary, {status:body.status, comparisonContract:BASELINE_PRESERVATION_CONTRACT, baselinePreserved:true, outputsAdded:0});
    console.log(JSON.stringify(summary));
  }
  console.log('Maintenance ' + action + ' confirmed');
} catch {
  console.error('Maintenance refused or response unknown. Retain the owner token for recovery; check the current service and reservation before retrying. Legacy services require a separately controlled offline update.');
  process.exitCode = 1;
}
