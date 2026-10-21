import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, chown, rm, access, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { SSHConnection } from 'ssh-mcp/build/ssh/connection.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { executePythonSource } from '../src/adapters/ssh/vendor.mjs';
import { preparePythonSource } from '../src/adapters/ssh/python-source.mjs';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  assert.fail('Timed out: ' + (typeof label === 'function' ? label() : label));
}
const portReady = () => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port: 2222 });
  socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => { socket.destroy(); resolve(false); });
});

// Explicit integration runner: only a dedicated Linux container with the
// synthetic mcpfixture account may run it. It never reads a real server ENV/key.
test('SOURCE-LINUX-01 actual MCP/app/OpenSSH/POSIX source contract and privilege/replay boundaries', { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  assert.equal(process.env.SOURCE_LINUX_FIXTURE, 'synthetic-only');
  assert.equal(process.getuid(), 0, 'Only the dedicated container test controller runs as root');
  assert.equal((await stat('/run')).mode & 0o777, 0o755, 'Dedicated /run tmpfs must preserve StrictModes-safe ancestors');
  const root = await mkdtemp('/run/jev-source-linux-'); await chmod(root, 0o755);
  const space = await statfs(root);
  assert.ok(space.bavail * space.bsize > 17 * 1024 * 1024, 'Fixture storage must satisfy the unchanged 16MiB output reservation plus headroom');
  const remote = join(root, 'remote work 한글'), state = join(root, 'state');
  await mkdir(remote, { mode: 0o700 }); await chown(remote, 10002, 10002); await mkdir(state, { mode: 0o700 });
  const hostKey = key(), privateKey = key(), parsedHost = ssh2.utils.parseKey(hostKey), parsedUser = ssh2.utils.parseKey(privateKey);
  await writeFile(join(root, 'host-key'), hostKey, { mode: 0o600 });
  await writeFile(join(root, 'authorized-keys'), 'ssh-rsa ' + parsedUser.getPublicSSH().toString('base64') + ' fixture\n', { mode: 0o644 });
  const config = ['Port 2222', 'ListenAddress 127.0.0.1', 'HostKey ' + join(root, 'host-key'), 'PidFile ' + join(root, 'sshd.pid'),
    'AuthorizedKeysFile ' + join(root, 'authorized-keys'), 'AllowUsers mcpfixture', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PermitEmptyPasswords no', 'UsePAM no', 'StrictModes yes', 'PrintMotd no', 'LogLevel VERBOSE'].join('\n') + '\n';
  await writeFile(join(root, 'sshd-config'), config, { mode: 0o600 });
  // /run is a fresh private tmpfs at runtime; the image's /run/sshd is masked.
  const beforeRuntimeDirectory = spawnSync('/usr/sbin/sshd', ['-t', '-f', join(root, 'sshd-config')], { encoding: 'utf8' });
  if (beforeRuntimeDirectory.status !== 0) t.diagnostic('OpenSSH initial config check: ' + beforeRuntimeDirectory.stderr.trim());
  await mkdir('/run/sshd', { recursive: true, mode: 0o755 });
  const sshConfig = spawnSync('/usr/sbin/sshd', ['-t', '-f', join(root, 'sshd-config')], { encoding: 'utf8' });
  assert.equal(sshConfig.status, 0, sshConfig.stderr);
  let app, client, daemonLog = '';
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd-config')], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SOURCE_LINUX_INHERITED_SENTINEL: 'must-not-reach-source' } });
  const daemonClosed = new Promise(resolve => daemon.once('close', resolve)); daemon.on('error', error => { daemonLog += error.code; });
  daemon.stderr.on('data', chunk => { daemonLog = (daemonLog + chunk.toString()).slice(-2000); });
  const profile = { name: 'aws-local', host: '127.0.0.1', port: 2222, user: 'mcpfixture', auth: 'key',
    trustedHostKey: 'SHA256:' + createHash('sha256').update(parsedHost.getPublicSSH()).digest('base64').replace(/=+$/, ''),
    tty: false, readOnly: false, announceAgent: false, timeout: 8000, maxOutputBytes: 65536 };
  const connection = new SSHConnection(profile, { privateKey }, new Map(), 'strict');
  const transportExec = connection.exec;
  connection.exec = async function (...args) {
    try { return await transportExec.apply(this, args); }
    catch (error) { t.diagnostic('Synthetic SSH exec diagnostic: ' + error.message); throw error; }
  };
  const registry = { getProfile: name => name === profile.name ? profile : { ...profile, name, readOnly: true },
    async getOrCreate() { await connection.ensureConnected(); return connection; }, closeAll: () => connection.close() };
  t.after(async () => {
    await client?.close(); await app?.close(); await connection.close();
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
    await Promise.race([daemonClosed, delay(2000)]);
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    await daemonClosed;
    assert.ok(root.startsWith('/run/jev-source-linux-')); await rm(root, { recursive: true, force: true });
  });
  await until(portReady, () => 'OpenSSH loopback listener; protected fixture diagnostic: ' + daemonLog);
  try { await registry.getOrCreate(profile.name); }
  catch (error) { assert.fail('Synthetic SSH connection preflight: ' + error.message + '\n' + daemonLog); }
  const inputs = [], plans = [], events = [];
  const model = 'jev-1.14.0', questionVersion = 'ssh-command-risk-v4';
  const env = { BRIDGE_MCP_TOKEN: 'synthetic-linux-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-linux-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true' };
  const create = () => createApplication({ registry, classify: classifyCommand, audit: event => events.push(event), transferRoot: state, uiHtml: '<html></html>', env,
    riskEvaluators: { jev: { model, questionVersion, assess: async input => { inputs.push(input); return { status: 'assessed', model, label: 'low_risk', confidence: 0.1, probabilities: { low_risk: 0.99, high_risk: 0.005, uncertain: 0.005 } }; } } },
    executeCommand: async (_profile, command) => { const result = await connection.exec(command); return { failed: result.exitCode !== 0, texts: [result.stdout] }; },
    executePythonSource: async (plan, verify) => { plans.push(plan); try { return await executePythonSource(registry, plan, verify); }
      catch (error) { t.diagnostic('Source port diagnostic: ' + error.message); throw error; } } });
  let origin;
  async function connect() {
    app = await create();
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + app.adminHttp.address().port;
    await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
    client = new Client({ name: 'synthetic-linux-source', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + env.BRIDGE_MCP_TOKEN } } }));
  }
  await connect();
  const api = async (path, body, token = env.BRIDGE_ADMIN_TOKEN) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, Origin: env.BRIDGE_ADMIN_ORIGIN, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  async function policy(grant = 'python-source-v1') {
    const current = (await api('/api/command-policy')).body, binding = current.bindings[0];
    const proposal = { expectedRevision: current.revision, policy: { targets: [{ targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, commands: [], deniedCommands: [], automaticSudo: true,
      sourceExecutionContract: grant, externalDisclosure: true, modelExecution: true, fallback: null,
      thresholds: { jev: { model, questionVersion, basis: 'safety-probability-v1', minLowRisk: 0.7, validationRef: 'synthetic:linux-source' } } }] } };
    const review = await api('/api/command-policy/review', proposal); assert.equal(review.status, 200);
    assert.equal((await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true })).status, 200);
    return binding;
  }
  const binding = await policy();
  const call = async args => {
    const response = await client.callTool({ name: 'run-python-source', arguments: args }); assert.ok(!response.isError, 'SOURCE-LINUX: MCP source request refused');
    await app.targets.drain(); return app.queue.get(response.structuredContent.id);
  };
  const output = async job => { const response = await api('/api/outputs/' + job.result.output.id); assert.equal(response.status, 200); return response.body.text; };
  const context = 'Isolated synthetic Linux fixture. Only owned scratch files are changed and restored. No network, dependencies, secrets or service changes.';
  const literal = "literal ' ; $(printf shell-expanded) 한글";
  const source = "# SOURCE_LINUX_PRIVATE_BODY\nimport os,sys,json,pathlib\np=pathlib.Path(sys.argv[1])\np.write_text(sys.argv[2],encoding='utf-8')\nassert p.read_text(encoding='utf-8')==sys.argv[2]\np.unlink()\nprint(json.dumps({'uid':os.geteuid(),'cwd':os.getcwd(),'args':sys.argv,'env':dict(os.environ),'utf8':sys.flags.utf8_mode,'fileProvided':'__file__' in globals(),'stdin':sys.stdin.read()},ensure_ascii=False,sort_keys=True))\n";
  const args = { source, argv: [join(remote, 'literal.txt'), literal], cwd: remote, context, requestKey: 'source-linux-normal-0001' };
  const normal = await call(args);
  if (normal.state !== 'completed') { t.diagnostic(JSON.stringify({ state: normal.state, reason: normal.decision?.reasonCode, inputs: inputs.length, plans: plans.length })); t.diagnostic(daemonLog); }
  assert.equal(normal.state, 'completed'); assert.equal(normal.approvalMode, 'automatic');
  const observed = JSON.parse(await output(normal));
  assert.deepEqual(observed, { uid: 10002, cwd: remote, args: ['<ssh-python-source-v1>', ...args.argv], env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' }, utf8: 1, fileProvided: false, stdin: '' });
  assert.equal(await access(args.argv[0]).then(() => true, () => false), false);
  assert.equal(JSON.parse(inputs[0].context).submittedSource.source, source); assert.equal(plans[0].stdin, source);
  assert.equal(plans[0].manifest.sourceBytes, Buffer.byteLength(source)); assert.equal(plans[0].manifest.sourceSha256, sha(source));
  assert.equal(normal.operation.sourcePlanDigest, plans[0].planDigest);
  const protectedPath = join(root, 'protected-fixture.txt'), original = Buffer.from('original protected bytes\n한글\n');
  await writeFile(protectedPath, original, { mode: 0o600 });
  const changeSource = "# SOURCE_LINUX_PROTECTED_BODY\nimport os,sys,pathlib,json\np=pathlib.Path(sys.argv[1])\nb=p.read_bytes()\ntry:\n p.write_bytes(b'changed synthetic fixture')\n assert p.read_bytes()==b'changed synthetic fixture'\nfinally:\n p.write_bytes(b)\nprint(json.dumps({'uid':os.geteuid(),'restored':p.read_bytes()==b}))\n";
  const protectedArgs = { source: changeSource, argv: [protectedPath], cwd: remote, context };
  const refused = await call({ ...protectedArgs, requestKey: 'source-linux-no-sudo-0001' }); assert.equal(refused.state, 'failed');
  assert.deepEqual(await readFile(protectedPath), original);
  const elevated = await call({ ...protectedArgs, elevate: true, requestKey: 'source-linux-sudo-0001' }); assert.equal(elevated.state, 'completed');
  const elevatedText = await output(elevated);
  let elevatedData;
  try { elevatedData = JSON.parse(elevatedText); } catch (error) { t.diagnostic('Synthetic elevated output diagnostic: ' + elevatedText); throw error; }
  assert.deepEqual(elevatedData, { uid: 0, restored: true }); assert.deepEqual(await readFile(protectedPath), original);
  assert.equal(plans[2].manifest.elevate, true); assert.match(plans[2].command, /^'sudo' '-n' '--'/);

  // Exercise delivery damage on a real OpenSSH channel/POSIX receiver, below
  // the application adapter (which otherwise refuses a changed source plan).
  const marker = join(remote, 'wire-marker.txt');
  const prefix = "import pathlib,sys\npathlib.Path(sys.argv[1]).write_text('unexpected-prefix',encoding='utf-8')\n";
  const full = prefix + "print('wire-complete 한글')\n";
  const wirePlan = preparePythonSource({ ...binding, source: full, argv: [marker], cwd: remote });
  const wrong = Buffer.from(full); wrong[0] ^= 1;
  for (const delivery of [prefix, wrong, full + '# trailing\n']) {
    const result = await connection.exec(wirePlan.command, { stdin: delivery });
    assert.equal(result.exitCode, 125, 'SOURCE-LINUX integrity refusal must precede prefix execution');
    assert.equal(await access(marker).then(() => true, () => false), false, 'SOURCE-LINUX damaged input executed a valid writing prefix');
  }
  const complete = await executePythonSource(registry, wirePlan, () => binding); assert.equal(complete.failed, false);
  assert.match(complete.texts[0], /wire-complete 한글/); assert.equal(await readFile(marker, 'utf8'), 'unexpected-prefix'); await rm(marker);
  await policy(null);
  const pending = await call({ ...args, requestKey: 'source-linux-owner-0001' }); assert.equal(pending.state, 'pending');
  const raw = await api('/api/' + pending.id + '/source'); assert.equal(raw.status, 200); assert.equal(raw.body.source, source); assert.equal(raw.headers.get('cache-control'), 'no-store');
  assert.equal((await api('/api/' + pending.id + '/source', undefined, env.BRIDGE_MCP_TOKEN)).status, 401);
  assert.equal((await api('/api/' + pending.id + '/approve', {})).status, 200); await app.targets.drain();
  assert.equal(app.queue.get(pending.id).state, 'completed'); assert.equal(app.queue.get(pending.id).approvalMode, 'owner');
  assert.equal((await api('/api/' + pending.id + '/source')).status, 409); assert.equal(plans.length, 4); assert.equal(inputs.length, 3);
  const replay = await call(args); assert.equal(replay.id, normal.id); assert.equal(plans.length, 4);
  await client.close(); await app.close(); await connect();
  assert.equal((await call(args)).id, normal.id); assert.equal(plans.length, 4, 'Restart/stable-key replay dispatched source again');
  assert.doesNotMatch(JSON.stringify(events), /SOURCE_LINUX_PRIVATE_BODY|SOURCE_LINUX_PROTECTED_BODY/);
  await client.close(); await app.close(); client = undefined; app = undefined;
  assert.equal((await readFile(join(state, 'command-automation.sqlite'))).includes(Buffer.from('SOURCE_LINUX_PRIVATE_BODY')), false);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(state, 'command-outputs', 'manifest.sqlite'), { readOnly: true });
  try { const rows = db.prepare('SELECT body FROM outputs').all().map(row => JSON.parse(row.body)); assert.equal(rows.find(row => row.binding.executionId === normal.id).binding.operationDigest, plans[0].planDigest); } finally { db.close(); }
  const python = spawnSync('/usr/bin/python3', ['--version'], { encoding: 'utf8' }); assert.equal(python.status, 0);
  const sshVersion = spawnSync('/usr/sbin/sshd', ['-V'], { encoding: 'utf8' }); assert.equal(sshVersion.status, 0);
  t.diagnostic(JSON.stringify({ status: 'PASS', actualLinuxOpenSsh: true, actualPosixShell: true, platform: process.platform, architecture: process.arch, node: process.version,
    python: python.stdout.trim(), openssh: sshVersion.stderr.trim(), model: 'synthetic response only', productRequests: 4, productDispatches: plans.length,
    damagedWireRefusals: 3, unprivilegedUid: observed.uid, elevatedUid: 0, protectedBytesRestored: true, restartReplayDispatches: 0, actualJevCalls: 0, humanBurdenMeasured: false }));
});
