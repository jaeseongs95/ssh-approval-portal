import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadSecrets } from '../src/adapters/config/secrets.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';

// Synthetic Compose fixture only. The service never mounts this private proof directory.
const mode = process.argv[2];
assert.ok(['capture', 'verify'].includes(mode));
const secrets = await loadSecrets({ file: process.env.BRIDGE_TEST_ENV_FILE });
const { adminPort } = parseSettings(secrets);
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
    headers: { Authorization: 'Bearer ' + secrets.BRIDGE_ADMIN_TOKEN, Origin: secrets.BRIDGE_ADMIN_ORIGIN,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200, 'Synthetic owner API refused');
  return response.json();
};
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const policy = value => ({ revision: value.revision, targets: value.targets });
const snapshotPath = '/proof/baseline.json';
if (mode === 'capture') {
  const before = await api('/api/command-policy');
  assert.equal(before.targets.length, 0, 'Fixture must start without a policy');
  const proposal = { expectedRevision: before.revision, policy: { targets: before.bindings.map(({ targetId, targetRevision, profile }) => ({
    targetId, targetRevision, profile, commands: ['id'], deniedCommands: [], externalDisclosure: false,
    modelExecution: false, fallback: null, thresholds: {},
  })) } };
  assert.ok(proposal.policy.targets.length, 'No synthetic target binding');
  const review = await api('/api/command-policy/review', proposal);
  const saved = await api('/api/command-policy', { ...proposal, reviewToken: review.reviewToken, acknowledged: true });
  const jobs = (await api('/api/requests')).filter(job => job.kind === 'command' && job.state === 'completed');
  const outputs = jobs.map(job => job.result?.structuredContent?.output).filter(output => output?.state === 'ready');
  assert.ok(jobs.length && outputs.length, 'No completed command or saved output to preserve');
  const outputRows = [];
  for (const output of outputs) outputRows.push({ id: output.id, hash: hash(await api(`/api/outputs/${output.id}?format=json`)) });
  await writeFile(snapshotPath, JSON.stringify({ policy: hash(policy(saved)), jobs: jobs.map(job => ({ id: job.id, hash: hash(job) })), outputs: outputRows }), { flag: 'wx', mode: 0o600 });
  console.log(`PRESERVATION CAPTURE: nondefault policy, ${jobs.length} completed commands, ${outputs.length} saved outputs`);
} else {
  const baseline = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assert.ok(hash(policy(await api('/api/command-policy'))) === baseline.policy, 'Existing nondefault policy changed');
  const jobs = new Map((await api('/api/requests')).map(job => [job.id, job]));
  for (const row of baseline.jobs) assert.ok(jobs.has(row.id) && hash(jobs.get(row.id)) === row.hash, 'Existing completed command changed');
  for (const row of baseline.outputs) assert.ok(hash(await api(`/api/outputs/${row.id}?format=json`)) === row.hash, 'Existing saved output changed');
  console.log('PRESERVATION VERIFY: policy revision/rules, existing commands and actual output reads PASS');
}
