import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeProvisionalTask, provisionalPorts } from './aik-ags.fixture.mjs';

const input = { command: 'id -u', target: 'ssh://synthetic-host', environment: 'isolated fixture',
  context: 'Synthetic account; no SSH connection is performed.' };
const low = { assess: async () => ({ status: 'assessed', label: 'low_risk', confidence: 1 }) };

test('AIK authorization and AGS ACK do not become owner approval or completion', async () => {
  const ports = provisionalPorts();
  const report = await observeProvisionalTask(input, low, ports);
  assert.equal(report.delivery, 'acked');
  assert.equal(report.assessment.label, 'low_risk');
  assert.equal(report.ownerApproval, 'not_requested');
  assert.equal(report.executionStatus, 'not_dispatched');
  assert.equal(report.businessCompleted, false);
  assert.equal(report.executions, 0);
  assert.equal(ports.sends, 1);
  assert.equal(ports.events[1].kind, 'send_intent');
});

test('unknown delivery keeps the prepared ID and does not retry or classify', async () => {
  const ports = provisionalPorts({ delivery: 'unknown' });
  const report = await observeProvisionalTask(input, { assess() { assert.fail('unexpected call'); } }, ports);
  assert.equal(report.delivery, 'unknown');
  assert.equal(report.messageId, ports.events[1].messageId);
  assert.equal(report.assessment, null);
  assert.equal(ports.sends, 1);
  assert.equal(report.executions, 0);
});

test('AIK denial stops before sending or calling Jev', async () => {
  const ports = provisionalPorts({ authorized: false });
  const report = await observeProvisionalTask(input, { assess() { assert.fail('unexpected call'); } }, ports);
  assert.equal(report.delivery, 'not_sent');
  assert.equal(ports.sends, 0);
});

test('serialized ToolSession imitation is rejected', () => {
  const ports = provisionalPorts();
  assert.throws(() => ports.aik.request({ localFixture: true }, {}), /invalid_local_session/);
});

test('AIK target scheme/path validation refuses bare host and traversal before messaging', async () => {
  for (const target of ['synthetic-host', 'ssh://synthetic-host/..', 'ssh://synthetic-host//x', 'ssh://synthetic-host/']) {
    const ports = provisionalPorts();
    await assert.rejects(observeProvisionalTask({ ...input, target }, low, ports), /invalid_aik_target/);
    assert.equal(ports.sends, 0);
  }
});

test('AGS send requires prepared ID and prior intent', async () => {
  const ports = provisionalPorts();
  await assert.rejects(ports.cli.call('send', { messageId: 'caller-invented' }), /missing_intent/);
  assert.equal(ports.sends, 0);
});

test('AGS UTF-8 body limit and unsupported operations are enforced', async () => {
  const ports = provisionalPorts();
  await assert.rejects(ports.cli.call('prepare', { body: JSON.stringify({ schema: 'aik.peer.v1',
    kind: 'task', correlation_id: 'corr-1', payload: { text: '가'.repeat(1400) } }),
    sender: { host: 'synthetic', sessionId: 'sender' }, target: { host: 'synthetic', sessionId: 'worker' } }), /invalid_peer_request/);
  await assert.rejects(ports.cli.call('wait', {}), /unsupported_operation/);
});
