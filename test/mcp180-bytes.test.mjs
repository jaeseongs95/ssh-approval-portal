import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerPublicTools, publicInputSchemas, publicOutputSchemas, operationState, presentOperation } from '../src/adapters/mcp/public-contract.mjs';

const id = 'a'.repeat(48), uploadId = 'b'.repeat(48), downloadId = 'c'.repeat(48), revision = 'd'.repeat(64);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const job = (state = 'queued', kind = 'command', extra = {}) => ({ id, kind, state, targetId: 'default', targetRevision: revision,
  createdAt: 10, expiresAt: 10000, ...extra });

function fixture(overrides = {}) {
  const handlers = new Map();
  const server = { registerTool(name, descriptor, handler) { handlers.set(name, { descriptor, handler }); } };
  registerPublicTools(server, { settings: { adminOrigin: 'https://owner.example', maxBytes: 65536 },
    targets: { list: () => ({ defaultTarget: 'default', targets: [] }) }, ...overrides });
  return { handlers, async call(name, input) {
    const handler = handlers.get(name);
    const parsed = publicInputSchemas[name].parse(input);
    const reply = await handler.handler(parsed, {});
    publicOutputSchemas[name].parse(reply.structuredContent);
    assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
    return reply;
  } };
}

test('MCP 1.8 states and explicit output preserve the status trust boundary', async () => {
  for (const state of operationState.options) assert.equal(presentOperation(job(state)).state, state);
  assert.equal(presentOperation(job('completed', 'command', { result: { output: { id, state: 'ready', expiresAt: 1 } } })).output.state, 'expired');
  const page = { text: 'explicit output', offsetBytes: 0, nextOffset: 15, bytes: 15, totalBytes: 15, sha256: 'e'.repeat(64), eof: true, expiresAt: 10000 };
  const f = fixture({ operations: { observe: async () => ({ job: job('starting', 'command', {
    operationKey: 'example-output-0001', result: { failed: false, texts: ['PRIVATE_BODY'], data: { approvalTicket: 'PRIVATE_TICKET' } },
  }), event: 'timeout', outputPage: page, streamPage: { data: 'PRIVATE_RAW_STREAM' } }) } });
  const normal = await f.call('observe', { id });
  assert.equal(normal.structuredContent.data.waitTimedOut, true);
  assert.equal(normal.structuredContent.data.outputPage, null);
  assert.doesNotMatch(JSON.stringify(normal), /PRIVATE_|explicit output/);
  const explicit = await f.call('observe', { id, includeOutput: true });
  assert.equal(explicit.structuredContent.data.outputPage.text, page.text);
  assert.equal(explicit.structuredContent.data.streamPage, null);
  assert.doesNotMatch(JSON.stringify(explicit), /PRIVATE_RAW_STREAM/);
  const conflict = await f.call('observe', { id, operationKey: 'example-output-0001' });
  assert.equal(conflict.structuredContent.error.code, 'OPERATION_LOOKUP_REQUIRED');
});

test('MCP 1.8 file diagnostics retain policy refusal versus native OS failure', () => {
  for (const detail of [{ origin: 'policy', policyReason: 'UNTRUSTED_WRITER' }, { origin: 'os', nativeStep: 'open', nativeError: 32 }]) {
    const value = presentOperation(job('failed', 'upload', { result: { failed: true, texts: ['ignored'], data: {
      errorCode: 'PERMISSION_DENIED', allowedRoot: 'C:/files', diagnostic: detail,
    } } }));
    assert.equal(value.failureCode, 'PERMISSION_DENIED');
    assert.equal(value.allowedRoot, 'C:/files');
    assert.equal(value.diagnostic.origin, detail.origin);
    assert.equal(value.diagnostic.nativeError, detail.nativeError ?? null);
    assert.equal(value.diagnostic.policyReason, detail.policyReason ?? null);
  }
});

test('MCP 1.8 audit persistence failure stays distinct from successful remote execution', () => {
  const value = presentOperation(job('completed', 'command', { result: { failed: false }, auditError: 'PRIVATE_AUDIT_DETAIL' }));
  assert.equal(value.state, 'completed');
  assert.equal(value.failed, false);
  assert.equal(value.auditFailure, true);
  assert.equal(value.failureCode, null);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_AUDIT_DETAIL/);
});

test('MCP 1.8 preserves typed deadline, transport, cancellation and exit evidence without raw output', () => {
  for (const [reason, remoteState, cleanupComplete] of [['deadline', 'unknown', false], ['transport_lost', 'unknown', true], ['cancel', 'exited', true], ['exit', 'exited', true]]) {
    const value = presentOperation(job(reason === 'exit' ? 'completed' : 'failed', 'command', { result: { failed: reason !== 'exit', execution: {
      phase: 'settled', reason, remoteState, cleanupComplete, exitCode: reason === 'exit' ? 0 : null, signal: reason === 'cancel' ? 'TERM' : null,
      automaticReplay: false, timeoutMs: 120000, requiresReconciliation: remoteState === 'unknown', outputState: 'partial', captureFailed: false,
      stdout: { receivedBytes: 12, retainedBytes: 8, cursor: 8, truncated: true }, stderr: { receivedBytes: 0, retainedBytes: 0, cursor: 0, truncated: false },
      rawOutput: 'PRIVATE_EXECUTION_BODY',
    } } }));
    assert.equal(value.execution.reason, reason); assert.equal(value.execution.remoteState, remoteState);
    assert.equal(value.execution.cleanupComplete, cleanupComplete); assert.equal(value.execution.automaticReplay, false);
    assert.equal(value.execution.exitCode, reason === 'exit' ? 0 : null); assert.equal(value.execution.signal, reason === 'cancel' ? 'TERM' : null);
    assert.equal(value.execution.stdout.cursor, 8);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_EXECUTION_BODY|rawOutput/);
  }
});

test('MCP 1.8 binary contract transfers bytes without UI, URLs, shell or local stdio', async () => {
  // This is an adapter contract fixture; actual Linux/Windows SSH round trips are separate acceptance evidence.
  for (const [target, remotePath] of [['default', '/tmp/bytes.bin'], ['windows', 'C:/files/bytes.bin']]) {
    const source = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, n) => n)), Buffer.from('가\0\r\n')]);
    let metadata, received = Buffer.alloc(0), sequence = 0, submitted = false, appends = 0;
    const request = job('completed', 'upload', { id: uploadId, targetId: target });
    const transfer = () => ({ id, received: received.length, sequence, size: metadata.size, sha256: metadata.sha256,
      expiresAt: 10000, targetId: target, targetRevision: revision });
    const f = fixture({ files: {
      beginAgentUpload: async input => { metadata = input; return transfer(); },
      appendAgentUpload: async input => { appends++; assert.equal(input.sequence, sequence); received = Buffer.concat([received, input.bytes]); return { received: received.length, sequence: ++sequence }; },
      agentUploadStatus: () => submitted ? { state: 'submitted', job: request } : { state: 'staging', transfer: transfer() },
      finishAgentUpload: async () => { assert.equal(received.length, metadata.size); assert.equal(sha256(received), metadata.sha256); submitted = true; return request; },
      readDownload: async ({ id: requested, offsetBytes, maxBytes }) => {
        assert.equal(requested, downloadId);
        const bytes = received.subarray(offsetBytes, offsetBytes + maxBytes);
        return { id: requested, artifactId: id, fileName: metadata.fileName, encoding: 'base64', data: bytes.toString('base64'), offsetBytes,
          bytes: bytes.length, nextOffset: offsetBytes + bytes.length, totalBytes: received.length, sha256: sha256(received),
          eof: offsetBytes + bytes.length === received.length, expiresAt: 10000 };
      },
    }, operations: { submit: async input => { assert.equal(input.kind, 'download'); return job('completed', 'download', { id: downloadId, targetId: target,
      result: { failed: false, texts: [], data: { artifactId: id, fileName: metadata.fileName, size: received.length, sha256: sha256(received) } } }); } } });
    const begin = await f.call('artifact-begin', { operationKey: 'example-binary-upload-0001', target, expectedTargetRevision: revision,
      fileName: 'bytes.bin', size: source.length, sha256: sha256(source), remotePath });
    assert.equal(begin.structuredContent.data.id, id);
    for (const data of ['AB==', 'AA==\n', '_w==']) {
      const invalid = await f.call('artifact-chunk', { id, sequence: 0, data });
      assert.equal(invalid.structuredContent.error.code, 'ARTIFACT_INVALID_CHUNK');
    }
    assert.equal(appends, 0);
    for (let offset = 0; offset < source.length; offset += 31) await f.call('artifact-chunk', { id, sequence, data: source.subarray(offset, offset + 31).toString('base64') });
    await f.call('artifact-finish', { id });
    const status = await f.call('artifact-status', { id });
    assert.equal(status.structuredContent.data.request.id, uploadId);
    await f.call('submit', { kind: 'download', operationKey: 'example-binary-download-0001', target, remotePath });
    let output = Buffer.alloc(0), offsetBytes = 0;
    do {
      const reply = await f.call('artifact-read', { id: downloadId, offsetBytes, maxBytes: 7 });
      const page = reply.structuredContent.data;
      assert.equal(page.bytes, Buffer.from(page.data, 'base64').length);
      assert.equal(page.nextOffset, offsetBytes + page.bytes);
      assert.equal(page.sha256, sha256(source));
      assert.doesNotMatch(JSON.stringify(reply), /ticket|downloadUrl|ownerId/);
      output = Buffer.concat([output, Buffer.from(page.data, 'base64')]); offsetBytes = page.nextOffset;
      if (page.eof) break;
      assert.ok(page.bytes > 0, 'pagination must advance');
    } while (offsetBytes <= source.length);
    assert.deepEqual(output, source);
  }
});

test('MCP 1.8 desktop observation returns actual image content and no owner identity', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const lease = { sessionId, epoch: 1, targetId: 'windows', targetRevision: revision, expiresAt: 10000, idleExpiresAt: 9000, kind: 'desktop', ownerId: 'PRIVATE_OWNER' };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSAAAAAASUVORK5CYII=';
  const f = fixture({ desktop: { open: async () => lease, observe: async () => ({ ...lease, frameId: sessionId + ':1', width: 1, height: 1,
    geometryRevision: 1, coordinateSpace: 'physical-pixels', nextInputSequence: 1, mimeType: 'image/png', data: png }) } });
  await f.call('desktop-open', { target: 'windows', expectedTargetRevision: revision });
  const frame = await f.call('desktop-observe', { sessionId, epoch: 1 });
  assert.equal(frame.structuredContent.data.imageContentIndex, 1);
  assert.deepEqual(frame.content[1], { type: 'image', mimeType: 'image/png', data: png });
  assert.doesNotMatch(JSON.stringify(frame.structuredContent), /PRIVATE_OWNER|ownerId/);
});
