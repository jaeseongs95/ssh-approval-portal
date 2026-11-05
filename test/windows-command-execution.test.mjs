import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { prepareWindowsCommand, wrapWindowsCommand } from '../src/adapters/ssh/windows-command.mjs';
import { presentStderr } from '../src/adapters/ssh/execution-supervisor.mjs';

const decoded = command => Buffer.from(command.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');
test('all Windows command catch paths report the original ErrorRecord and source position', () => {
  const marker = "throw 'deliberate-test-error-7f3a'";
  const direct = decoded(wrapWindowsCommand(marker)), prepared = prepareWindowsCommand(marker), bootstrap = decoded(prepared.command);
  const packed = bootstrap.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1], receiver = gunzipSync(Buffer.from(packed, 'base64')).toString('utf8');
  for (const script of [direct, bootstrap, receiver]) {
    assert.ok(script.includes('[Console]::Error.WriteLine($_.ToString())'));
    assert.ok(script.includes('InvocationInfo.PositionMessage'));
    assert.ok(!script.includes("WriteLine('Windows command failed')"));
  }
  assert.equal(prepared.stdin, marker); assert.ok(direct.includes(marker));
  assert.ok(direct.includes("$ProgressPreference='SilentlyContinue'"));
  assert.ok(receiver.includes("$ProgressPreference='SilentlyContinue'"));
});

test('CLIXML progress noise is removed from presentation while stderr remains caller-owned', () => {
  const raw = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><MS><PR N="Record" /></MS></Obj></Objs>';
  assert.equal(presentStderr(raw), ''); assert.ok(raw.includes('progress'));
  const mixed = raw.replace('</Objs>', '<S S="Error">deliberate-test-error-7f3a</S></Objs>');
  assert.ok(presentStderr(mixed).includes('deliberate-test-error-7f3a')); assert.ok(!presentStderr(mixed).includes('S="progress"'));
  assert.equal(presentStderr('plain stderr\n'), 'plain stderr\n');
});
