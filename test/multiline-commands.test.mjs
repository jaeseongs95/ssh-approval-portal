import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../app.mjs';
import { validateCommand, remotePath, windowsRemotePath } from '../src/domain/validation.mjs';
import { commandRequest } from '../src/domain/execution-context.mjs';
import { commandDigest, explicitUserApproval } from '../src/domain/command-policy.mjs';
import { commandLineNames } from '../src/domain/command-line.mjs';
import { windowsCommandLineNames } from '../src/domain/windows-command-line.mjs';
import { validateWindowsCommand, classifyForTarget } from '../src/domain/target-platform.mjs';
import { prepareWindowsCommand } from '../src/adapters/ssh/windows-command.mjs';

// engineering-test-plan: ML-INPUT/IDENTITY cover exact UTF-8 command admission,
// 32 KiB limits and unchanged path restrictions at the public validation boundary.
// ML-AUTH covers read/name refusal and owner/model/TEST authority through the real
// app, queue, journal and administrator API; only SSH and paid evaluators are fake.
// ML-SH executes synthetic heredocs using the Linux CI shell. Windows here-string
// execution belongs to windows-ssh-integration.test.mjs and its existing fixture.
// Red proof: on 6b90681 the ML-INPUT acceptance assertion and ML-AUTH submissions
// fail with Invalid command / Invalid Windows command. Execute identical tests
// against an isolated baseline and candidate in CI; local product runs forbidden.
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const context = 'Synthetic multiline command fixture; inspect only synthetic output.';
const low = { status: 'assessed', model: 'jev-1.14.0', label: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0 } };
const threshold = { model: low.model, questionVersion: 'ssh-command-risk-v5', basis: 'safety-probability-v1', minLowRisk: 0.9, validationRef: 'synthetic:multiline' };
const linuxCommands = [
  "cat <<'EOF'\n한글 $HOME `literal`\nEOF\n",
  'VALUE=expanded\ncat <<EOF\n$VALUE\nEOF\n',
  "cat <<-'EOF'\n\t한글\n\tEOF\n",
  "cat <<'EOF' | tr a-z A-Z\nhello\nEOF\nprintf 'done'\n",
];
const windowsCommands = [
  "$value = @'\n한글 $env:PATH 'literal'\n'@\n[Console]::Write($value)",
  '$value = @"\r\n한글 `"quoted`"\r\n"@\r\n[Console]::Write($value)',
  "\t[Console]::Write('first')\r\n[Console]::Write('second')\r\n",
];

test('ML-INPUT accepts LF, CRLF and heredoc tabs without changing classifier input', () => {
  for (const command of [...linuxCommands, ...windowsCommands, 'printf\tfixture', 'printf first\r\nprintf second\r\n']) {
    let seen;
    assert.doesNotThrow(() => validateCommand(command, value => { seen = value; return { class: 'safe' }; }));
    assert.equal(seen, command);
    assert.doesNotThrow(() => validateWindowsCommand(command));
    const request = commandRequest('ssh-request-v1:' + JSON.stringify({ command, context }));
    assert.equal(request.command, command);
    assert.equal(sha256(request.command), sha256(command));
  }
});

test('ML-IDENTITY newline, tab and surrounding whitespace remain distinct digest subjects', () => {
  const commands = ['printf first\nprintf second\n', 'printf first\r\nprintf second\r\n', ' printf first\nprintf second\n', 'printf first\nprintf second', 'printf\tfirst\nprintf second\n'];
  const digests = commands.map(command => commandDigest(command, 'a'.repeat(64), 'synthetic', context));
  assert.equal(new Set(digests).size, commands.length);
  for (const command of commands) {
    const expected = sha256(JSON.stringify({ command, targetRevision: 'a'.repeat(64), profile: 'synthetic', context }));
    assert.equal(commandDigest(command, 'a'.repeat(64), 'synthetic', context), expected);
    const prepared = prepareWindowsCommand(command);
    assert.equal(prepared.stdin, command);
    assert.equal(sha256(prepared.stdin), sha256(command));
  }
});

test('ML-BOUND exact 32KiB multiline UTF-8 accepted; excess and forbidden controls refused before classifier', () => {
  for (const atom of ['x', '가', '😀']) {
    const prefix = "cat <<'EOF'\n\t", suffix = '\nEOF\n';
    const available = 32768 - Buffer.byteLength(prefix + suffix), count = Math.floor(available / Buffer.byteLength(atom));
    const command = prefix + atom.repeat(count) + 'x'.repeat(available - count * Buffer.byteLength(atom)) + suffix;
    assert.equal(Buffer.byteLength(command), 32768);
    assert.doesNotThrow(() => validateCommand(command, () => ({ class: 'safe' })));
    assert.doesNotThrow(() => validateWindowsCommand(command));
    let calls = 0;
    assert.throws(() => validateCommand(command + 'x', () => { calls++; return { class: 'safe' }; }));
    assert.equal(calls, 0);
    assert.throws(() => validateWindowsCommand(command + 'x'));
  }
  for (const control of ['\0', '\r', '\x01', '\x08', '\x0b', '\x0c', '\x1b', '\x1f', '\x7f', '\x85', '\u202e', '\u2066', '\ud800', '\udc00']) {
    const command = 'printf first\n' + control + 'printf second';
    let calls = 0;
    assert.throws(() => validateCommand(command, () => { calls++; return { class: 'safe' }; }));
    assert.equal(calls, 0);
    assert.throws(() => validateWindowsCommand(command));
  }
  for (const command of ['', ' \n\t\r\n']) {
    assert.throws(() => validateCommand(command, () => ({ class: 'safe' })));
    assert.throws(() => validateWindowsCommand(command));
  }
  for (const control of ['\n', '\r', '\t']) {
    assert.throws(() => remotePath('/tmp/first' + control + 'second'));
    assert.throws(() => windowsRemotePath('C:/synthetic/first' + control + 'second'));
  }
});

test('ML-NAMES multiline syntax never establishes partial name or Windows read approval', () => {
  for (const command of [...linuxCommands, 'ls\nid', 'ls\r\nid', 'ls\n', '\nls', 'ls\nrm synthetic']) {
    assert.equal(commandLineNames(command).complete, false, command);
    assert.equal(explicitUserApproval(command, ['cat', 'tr', 'printf', 'ls', 'id', 'rm']).explicit, false, command);
  }
  const classifyWindows = classifyForTarget({ platform: 'windows' }, () => ({ class: 'read-only' }));
  for (const command of [...windowsCommands, 'whoami.exe\nwhoami.exe', 'Microsoft.PowerShell.Utility\\Get-Date\n', '\r\nMicrosoft.PowerShell.Management\\Get-Location']) {
    assert.equal(windowsCommandLineNames(command).complete, false, command);
    assert.equal(explicitUserApproval(command, ['whoami.exe', 'Microsoft.PowerShell.Utility\\Get-Date', 'Microsoft.PowerShell.Management\\Get-Location'], 'windows').explicit, false, command);
    assert.notEqual(classifyWindows(command).class, 'read-only', command);
  }
});

async function fixture(t, platform, automation = true) {
  const root = await mkdtemp(join(tmpdir(), 'multiline-commands-')), executions = [], inputs = [], events = [];
  const entry = { id: 'fixture', displayName: 'Synthetic multiline target', readProfile: 'fixture-read', writeProfile: 'fixture-write', credentialRevision: 'v1', platform };
  const app = await createApplication({ transferRoot: root, uiHtml: '<html>fixture</html>',
    env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test',
      BRIDGE_COMMAND_AUTOMATION: String(automation), BRIDGE_TARGETS: JSON.stringify([entry]), BRIDGE_DEFAULT_TARGET: entry.id, BRIDGE_TEST_SERVER_SECRET_REF: 'secret://fixture/test-server' },
    registry: { getProfile: name => ({ host: 'synthetic.example.test', port: 22, user: 'fixture', trustedHostKey: 'SHA256:synthetic', readOnly: name === entry.readProfile }), closeAll: async () => {} },
    classify: () => ({ class: 'read-only' }), audit: event => events.push(event), secretResolver: { resolve: async () => '1'.repeat(64) },
    executeCommand: async (profile, command, beforeDispatch, options) => { await beforeDispatch(); executions.push({ profile, command, stdin: typeof options === 'string' ? options : options?.stdin }); return { failed: false, texts: ['synthetic output'] }; },
    riskEvaluators: { jev: { model: low.model, questionVersion: 'ssh-command-risk-v5', async assess(input) { inputs.push(input); return low; } } },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const api = async (path, body) => {
    const response = await fetch('http://127.0.0.1:' + app.adminHttp.address().port + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer synthetic-owner', ...(body === undefined ? {} : { Origin: 'https://owner.test', 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const policy = async changes => {
    const current = (await api('/api/command-policy')).body, binding = current.bindings[0];
    const rule = { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, platform,
      commands: platform === 'windows' ? ['whoami.exe'] : ['ls', 'id', 'cat', 'printf', 'tr'], deniedCommands: [], automaticSudo: true,
      externalDisclosure: true, modelExecution: false, fallback: null, thresholds: {}, ...changes };
    const proposal = { expectedRevision: current.revision, policy: { targets: [rule] } };
    const review = await api('/api/command-policy/review', proposal); assert.equal(review.status, 200);
    assert.equal((await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true })).status, 200);
    inputs.length = 0;
  };
  const run = async (command, requestKey) => {
    const result = await app.targets.commands.run(command, entry.id, requestKey, context);
    await app.targets.drain();
    return result.type === 'job' ? app.queue.get(result.job.id) : result;
  };
  return { app, run, policy, inputs, executions, events, entry };
}

for (const platform of ['linux', 'windows']) {
  test(`ML-AUTH ${platform} multiline requires full review and preserves owner/model/TEST routes`, async t => {
    const f = await fixture(t, platform), raw = platform === 'linux' ? linuxCommands[2] : windowsCommands[0];
    await f.policy({});
    const pending = await f.run(raw, 'multiline-owner-key');
    assert.equal(pending.state, 'pending'); assert.equal(pending.command, raw); assert.equal(pending.operation.command, raw);
    assert.equal(pending.decision.reasonCode, 'observation_only'); assert.equal(f.inputs.length, 1);
    assert.equal(f.inputs[0].command, raw); assert.equal(f.inputs[0].userApproval.explicit, false); assert.equal(f.executions.length, 0);
    assert.equal((await f.run(raw, 'multiline-owner-key')).id, pending.id);
    await assert.rejects(f.run(raw.replaceAll('\n', '\r\n'), 'multiline-owner-key'), /conflict/i);
    const approved = await f.app.queue.approve(pending.id);
    assert.equal(approved.state, 'completed'); assert.equal(approved.command, raw);
    assert.equal(f.executions.length, 1); assert.equal(f.executions[0].profile, f.entry.writeProfile);
    assert.equal(platform === 'windows' ? f.executions[0].stdin : f.executions[0].command, raw);
    assert.ok(f.events.some(event => event.action === 'approved' && event.command === raw));
    await f.policy({ modelExecution: true, thresholds: { jev: threshold } });
    const model = await f.run(raw);
    assert.equal(model.state, 'completed'); assert.equal(model.decision.reasonCode, 'model_passed');
    assert.equal(f.inputs.length, 1); assert.equal(f.inputs[0].command, raw); assert.equal(f.inputs[0].userApproval.explicit, false);
    const deniedCommands = platform === 'linux' ? ['cat'] : ['Console'];
    await f.policy({ externalDisclosure: false, modelExecution: false, deniedCommands });
    const denied = await f.run(raw);
    assert.equal(denied.state, 'denied'); assert.equal(denied.decision.reasonCode, 'policy_denied');
    assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 2);
    await f.policy({ testServer: true, externalDisclosure: false, modelExecution: false, deniedCommands });
    const bypass = await f.run(raw);
    assert.equal(bypass.state, 'completed'); assert.equal(bypass.decision.reasonCode, 'test_server_bypass');
    assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 3);
    for (const execution of f.executions) assert.equal(platform === 'windows' ? execution.stdin : execution.command, raw);
  });

  test(`ML-READ ${platform} multiline cannot use an injected read-only prefix classification`, async t => {
    const f = await fixture(t, platform, false);
    const raw = platform === 'linux' ? 'ls\nid' : 'Microsoft.PowerShell.Utility\\Get-Date\n';
    await assert.rejects(f.app.targets.commands.read(raw, f.entry.id), { code: 'READ_COMMAND_REQUIRES_APPROVAL' });
    const job = await f.run(raw);
    assert.equal(job.state, 'pending'); assert.equal(job.command, raw); assert.equal(f.executions.length, 0);
  });
}

test('ML-SH real Linux shell executes quoted/unquoted/tab-stripped/piped heredocs', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  for (const [command, expected] of linuxCommands.map((command, index) => [command, ['한글 $HOME `literal`\n', 'expanded\n', '한글\n', 'HELLO\ndone'][index]])) {
    validateCommand(command, () => ({ class: 'safe' }));
    const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', command], { timeout: 2000, encoding: 'utf8', maxBuffer: 32768 });
    assert.equal(stdout, expected); assert.equal(stderr, '');
  }
});
