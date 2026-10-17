import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// A child CLI cannot contact a default port or any unrelated local/remote service.
if (process.env.SOLID_FETCH_ORIGIN) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== process.env.SOLID_FETCH_ORIGIN) throw Error('Fixture blocked an unexpected network destination');
    return realFetch(input, options);
  };
}
const fixtureFile = fileURLToPath(import.meta.url);
const deadlineScale = process.arch === 'arm64' ? 5 : 1;
const fixtureEnv = { BRIDGE_MCP_TOKEN: 'fixture-mcp-only', BRIDGE_ADMIN_TOKEN: 'fixture-admin-only', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_UI_ENABLED: 'true' };
const profile = { host: 'fixture.invalid', port: 22, user: 'fixture-user' };
const listen = server => new Promise(accept => server.listen(0, '127.0.0.1', accept));
async function runChild(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const timer = setTimeout(() => { child.kill(); reject(Error('Fixture child exceeded its deadline')); }, 10_000 * deadlineScale);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); accept({ code, signal, stdout, stderr }); });
  });
}
async function application(root, storage, options = {}) {
  const { createApplication } = await import(pathToFileURL(join(root, 'app.mjs')));
  return createApplication({ registry: { getProfile: name => ({ ...profile, readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: command => ({ class: command.startsWith('id ') ? 'read-only' : 'safe' }), executeCommand: async () => ({ content: [{ type: 'text', text: 'fixture-result' }] }),
    audit: () => {}, transferRoot: storage, env: fixtureEnv, uiHtml: '<html>fixture</html>', ...options });
}
async function connect(app) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await listen(app.mcpHttp); await listen(app.adminHttp);
  const client = new Client({ name: 'solid-public-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpHttp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + fixtureEnv.BRIDGE_MCP_TOKEN } } }));
  return client;
}
async function scenario(name, root, work) {
  if (name === 'AP-01') {
    const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
    let executions = 0;
    const app = await application(root, work, { audit: event => { if (event.action === 'expired') throw Error('Synthetic expired audit failure'); }, executeCommand: async () => { executions++; return { content: [] }; } });
    const client = await connect(app);
    try {
      const job = (await client.callTool({ name: 'run-command', arguments: { command: 'printf fixture-never-execute' } })).structuredContent;
      assert.equal(job.state, 'pending'); clock += 3_600_001;
      const response = await fetch(`http://127.0.0.1:${app.mcpHttp.address().port}/health`);
      assert.equal(response.status, 503, 'Expired-audit exception must be a controlled HTTP failure');
      await response.json();
      const next = await fetch(`http://127.0.0.1:${app.mcpHttp.address().port}/health`);
      assert.equal(next.status, 200, 'The child process must remain available');
      const status = (await client.callTool({ name: 'get-request-status', arguments: { id: job.id } })).structuredContent;
      assert.equal(status.state, 'expired');
      const deniedExecution = await fetch(`http://127.0.0.1:${app.adminHttp.address().port}/api/${job.id}/approve`, { method: 'POST', headers: { Authorization: 'Bearer ' + fixtureEnv.BRIDGE_ADMIN_TOKEN, Origin: fixtureEnv.BRIDGE_ADMIN_ORIGIN } });
      assert.equal(deniedExecution.status, 409); assert.equal(executions, 0);
      return { controlledStatus: response.status, processSurvived: true, state: status.state, executions };
    } finally { Date.now = realNow; await client.close(); await app.close(); }
  }
  if (name === 'AP-02') {
    const events = [];
    const app = await application(root, work, { audit: event => events.push(event.action), executeCommand: async (_profile, command) => {
      if (command === 'id fail-read') throw Error('PRIVATE_EXECUTOR_SENTINEL');
      return { content: [{ type: 'text', text: 'read-ok' }] };
    } });
    const client = await connect(app);
    try {
      for (const tool of ['read-command', 'run-command']) {
        const before = events.length;
        const result = await client.callTool({ name: tool, arguments: { command: 'id fail-read' } });
        assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('PRIVATE_EXECUTOR_SENTINEL'));
        assert.deepEqual(events.slice(before), ['read-started', 'read-failed'], 'Executor rejection must still have a terminal audit event');
        const health = await (await fetch(`http://127.0.0.1:${app.mcpHttp.address().port}/health`)).json();
        assert.equal(health.busy, false);
      }
      const result = await client.callTool({ name: 'read-command', arguments: { command: 'id recovered' } });
      assert.equal(result.isError, undefined); assert.equal((await client.callTool({name:'read-command-output',arguments:{outputId:result.structuredContent.output.id}})).content[0].text, 'read-ok');
      return { tools: 2, terminalFailureAudits: events.filter(action => action === 'read-failed').length, busyReleased: true, rawErrorHidden: true };
    } finally { await client.close(); await app.close(); }
  }
  if (name === 'AUTH-01') {
    const invalid = ['https://example.test?mode=1', 'https://example.test#fragment', 'https://user@example.test', 'https://EXAMPLE.test', 'https://example.test:443'];
    for (const origin of invalid) {
      let app, rejected = false;
      try { app = await application(root, work, { env: { ...fixtureEnv, BRIDGE_ADMIN_ORIGIN: origin } }); }
      catch { rejected = true; }
      finally { await app?.close(); }
      assert.equal(rejected, true, 'Noncanonical administrator origin passed application startup');
    }
    const app = await application(root, work, { env: { ...fixtureEnv, BRIDGE_ADMIN_ORIGIN: 'https://example.test:4443' } });
    await app.close(); return { noncanonicalOriginsRejected: invalid.length, canonicalCustomPortAccepted: true };
  }
  if (name === 'DELIVERY-01') {
    let calls = 0;
    const server = createServer((req, res) => {
      assert.equal(req.url, '/api/maintenance/reserve'); assert.equal(req.method, 'POST');
      assert.equal(req.headers.origin, fixtureEnv.BRIDGE_ADMIN_ORIGIN);
      assert.equal(req.headers.authorization, 'Bearer ' + fixtureEnv.BRIDGE_ADMIN_TOKEN); calls++;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"reserved":true}');
    });
    await listen(server);
    const envFile = join(work, 'settings.env');
    await writeFile(envFile, Object.entries({ ...fixtureEnv, BRIDGE_ADMIN_PORT: server.address().port }).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600 });
    try {
      const run = await runChild(process.execPath, ['--import', pathToFileURL(fixtureFile).href, join(root, 'scripts/maintenance.mjs'), 'reserve'], { env: { ...process.env, BRIDGE_SECRET_ENV_FILE: envFile, SOLID_FETCH_ORIGIN: `http://127.0.0.1:${server.address().port}` } });
      assert.equal(run.code, 0, 'Maintenance CLI did not reach the configured administrator port'); assert.equal(calls, 1);
      return { configuredPortUsed: true, authenticatedFixtureCalls: calls };
    } finally { await new Promise(accept => server.close(accept)); }
  }
  if (name === 'DELIVERY-02') {
    const packages = [
      ['node_modules/alpha', 'fixture-alpha', '1.0.0'],
      ['node_modules/@fixture/shared', '@fixture/shared', '1.0.0'],
      ['node_modules/alpha/node_modules/@fixture/shared', '@fixture/shared', '2.0.0'],
      ['ui/node_modules/ui-alpha', 'fixture-ui-alpha', '1.0.0'],
      ['ui/node_modules/ui-alpha/node_modules/@fixture/shared', '@fixture/shared', '3.0.0'],
    ];
    for (const [path, packageName, version] of packages) {
      await mkdir(join(work, path), { recursive: true });
      await writeFile(join(work, path, 'package.json'), JSON.stringify({ name: packageName, version, license: 'MIT' }));
      await writeFile(join(work, path, 'LICENSE'), 'Synthetic fixture license\n');
    }
    const output = join(work, 'THIRD_PARTY_NOTICES.json');
    const run = await runChild(process.execPath, [join(root, 'scripts/notices.mjs'), '--root', work, '--output', output], { cwd: work });
    assert.equal(run.code, 0, 'The notice generator CLI failed');
    const records = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(records.map(item => item.name + '@' + item.version).sort(), packages.map(([, packageName, version]) => packageName + '@' + version).sort(), 'Nested installed dependency versions must all have notices');
    return { exactInstalledVersions: records.length, nestedVersionsIncluded: true };
  }
  if (name === 'DELIVERY-03') {
    const file = join(work, 'compose.env');
    const before = '# owner-selected image\r\nBRIDGE_UID=11\r\nBRIDGE_GID=12\r\nBRIDGE_IMAGE=fixture-image@sha256:' + 'a'.repeat(64) + '\r\nEXTRA_SETTING=keep-this-value\r\n';
    await writeFile(file, before, { mode: 0o600 });
    const python = process.env.SOLID_PYTHON ?? (process.platform === 'win32' ? 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' : 'python3');
    const run = await runChild(python, [join(root, 'scripts/compose-env.py'), file, '10001', '10002']);
    assert.equal(run.code, 0, 'Compose environment CLI failed');
    assert.equal(await readFile(file, 'utf8'), before.replace('BRIDGE_UID=11', 'BRIDGE_UID=10001').replace('BRIDGE_GID=12', 'BRIDGE_GID=10002'), 'Host preparation must preserve the selected image, comments and extra settings');
    return { imagePreserved: true, extraSettingsPreserved: true, crlfPreserved: true };
  }
  throw Error('Unknown saved regression scenario');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fixtureFile)) {
  const [name, rootArgument, workArgument] = process.argv.slice(2), root = resolve(rootArgument);
  const work = workArgument ? resolve(workArgument) : await mkdtemp(join(tmpdir(), 'solid-regression-'));
  assert.ok(work.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
  try {
    const result = await scenario(name, root, work);
    process.send?.({ scenario: name, result: 'PASS', observations: result });
  } finally {
    // The only recursively removed tree is this process's own mkdtemp directory.
    assert.ok(resolve(work).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(work, { recursive: true, force: true });
  }
}
