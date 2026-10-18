import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadSecrets } from '../src/adapters/config/secrets.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';

// Runs only inside the isolated Docker test server, with its synthetic credentials.
const settings = await loadSecrets({ file: process.env.BRIDGE_TEST_ENV_FILE ?? '/etc/ssh-mcp-approval-bridge.env' });
const ports = parseSettings(settings);
const runPrefix = `portal-${randomBytes(12).toString('hex')}-`;
const client = new Client({ name: 'isolated-test-host', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ports.mcpPort}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + settings.BRIDGE_MCP_TOKEN } } }));
const call = async (name, args = {}) => { const value = await client.callTool({ name, arguments: args }); assert.ok(!value.isError, 'MCP operation failed: ' + name); return value; };
const digest = data => createHash('sha256').update(data).digest('hex');
const delay = () => new Promise(resolve => setTimeout(resolve, 100));
async function wait(id) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const job = (await call('get-request-status', { id })).structuredContent;
    if (['completed', 'failed'].includes(job.state)) { assert.equal(job.state, 'completed', 'Remote operation failed'); return job; }
    await delay();
  }
  assert.fail('Timed out');
}
async function approve(job) {
  const view = await call('show-approval', { id: job.id });
  const result = await call('ui-decide-request', { id: job.id, action: 'approve', ticket: view._meta.sshApproval.approvalTicket });
  assert.equal(result.structuredContent.state, 'running'); return wait(job.id);
}
try {
  const read = await call('read-command', { command: 'id -un' }); assert.ok((await call('read-command-output',{outputId:read.structuredContent.output.id})).content[0].text.includes('mcpops'));
  await approve((await call('run-command', { command: 'sudo -n id -u' })).structuredContent);
  const delayed = (await call('run-command', { command: 'sleep 1' })).structuredContent;
  const delayedCard = await call('show-approval', { id: delayed.id });
  await call('ui-decide-request', { id: delayed.id, action: 'approve', ticket: delayedCard._meta.sshApproval.approvalTicket });
  const racingRead = await client.callTool({ name: 'read-command', arguments: { command: 'id -un' } });
  assert.equal(racingRead.isError, true, 'Read bypassed the shared operation lock');
  await wait(delayed.id);
  for (const [name, bytes, elevate] of [['normal.bin', Buffer.from([0, 255, 1, 128]), false], ['한글.bin', Buffer.from('binary\0한글'), true], ['empty.bin', Buffer.alloc(0), false], ['text.txt', Buffer.from('UTF-8 한글\n'), false], ['folder.zip', Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64'), false], ['limit.bin', Buffer.alloc(64 * 1024 * 1024, 0xa5), false]]) {
    const remotePath = (elevate ? '/root/' : '/home/mcpops/') + runPrefix + name;
    const transfer = { direction: 'upload', remotePath, elevate, overwrite: false };
    const card = await call('show-file-transfer', transfer);
    const started = await call('ui-upload-begin', { transfer, ticket: card._meta.sshApproval.bootstrapTicket, fileName: name, size: bytes.length, sha256: digest(bytes) });
    const id = started.structuredContent.transferId, ticket = started._meta.sshApproval.uploadTicket;
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += 262144, sequence++) {
      const chunk = bytes.subarray(offset, offset + 262144).toString('base64');
      await call('ui-upload-chunk', { id, ticket, sequence, data: chunk });
      if (sequence === 0) await call('ui-upload-chunk', { id, ticket, sequence, data: chunk });
    }
    const upload = (await call('ui-upload-finish', { id, ticket })).structuredContent;
    await approve(upload);
    const request = (await call('request-download', { remotePath, elevate })).structuredContent;
    assert.equal(request.state, 'pending', 'Default file policy must require owner approval');
    const downloaded = await approve(request);
    assert.equal(downloaded.result.structuredContent.sha256, digest(bytes));
    const view = await call('show-approval', { id: request.id });
    const link = await call('ui-download-link', { id: request.id, ticket: view._meta.sshApproval.viewTicket });
    const remoteUrl = new URL(link._meta.sshApproval.downloadUrl);
    const localUrl = new URL(remoteUrl.pathname + remoteUrl.search, `http://127.0.0.1:${ports.adminPort}`);
    const response = await fetch(localUrl); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await fetch(localUrl)).status, 409, 'Download URL was replayable');
  }
  const rootOld = `/root/${runPrefix}portal-preserve.bin`;
  await approve((await call('run-command', { command: `sudo -n sh -c 'printf root-old > ${rootOld}'` })).structuredContent);
  const download = (await call('request-download', { remotePath: rootOld, elevate: true })).structuredContent;
  await approve(download);
  const config = { direction: 'upload', remotePath: `/home/mcpops/${runPrefix}too-big.bin`, elevate: false, overwrite: false };
  const card = await call('show-file-transfer', config);
  const excessive = await client.callTool({ name: 'ui-upload-begin', arguments: { transfer: config, ticket: card._meta.sshApproval.bootstrapTicket, fileName: 'too-big.bin', size: 64 * 1024 * 1024 + 1, sha256: '0'.repeat(64) } });
  assert.equal(excessive.isError, true);
  console.log('ACTUAL SSH: read, sudo approval, normal/root/empty/text/ZIP/64 MiB binary file roundtrip, over-limit rejection, one-use download link PASS');
} finally { await client.close(); }
