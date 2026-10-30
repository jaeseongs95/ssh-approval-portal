// 소유한 프로세스 시험: 실제 클라이언트·스냅샷을 사용하고 외부 HTTP 응답만 대체한다.
import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAgentUploadForwarder } from '../src/adapters/cli/agent-file-forwarder.mjs';
import { createPortalClient } from '../src/adapters/cli/portal-client.mjs';
import { startFileMcp } from '../scripts/portal-file-mcp.mjs';
const [journalRoot, source, log, mode] = process.argv.slice(2);
if (process.argv.length !== 6 || !['normal', 'crash'].includes(mode)) throw Error('INVALID_OWNED_FIXTURE');
const bytes = await readFile(source), size = bytes.length, sha256 = createHash('sha256').update(bytes).digest('hex');
const transferId = 'b'.repeat(48), requestId = 'c'.repeat(48), revision = 'd'.repeat(64);
const operation = { kind: 'upload', artifactId: transferId, remotePath: '/tmp/PRIVATE-agent.bin', elevate: false, overwrite: false, size, sha256, fileTargetId: 'default', fileTargetRevision: revision };
const job = { id: requestId, kind: 'upload', state: 'pending', operation };
const json = (value, cookie = false) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...(cookie ? { 'set-cookie': '__Host-ssh_admin_session=' + 'e'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600' } : {}) } });
const note = effect => appendFile(log, JSON.stringify({ effect }) + '\n', { encoding: 'utf8', mode: 0o600 });
const forwarder = await createAgentUploadForwarder({ origin: 'https://fixture.invalid', journalRoot, openClient: async origin => {
  let received = 0, sequence = 0;
  const client = createPortalClient({ origin, accessToken: 'SYNTHETIC.PRIVATE.TOKEN', fetch: async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/session') return json({ mode: 'access' });
    if (path === '/api/session/start') return json({ connected: true }, true);
    if (path === '/api/session/logout') return json({ connected: false });
    if (path === '/api/targets') return json({ targets: [{ id: 'default', enabled: true, revision }] });
    if (path === '/api/files/uploads') {
      await note('begin'); if (mode === 'crash') process.exit(23);
      return json({ transferId, received: 0, sequence: 0 });
    }
    if (path.endsWith('/chunks')) { const chunk = JSON.parse(options.body); received += Buffer.from(chunk.data, 'base64').length; sequence++; return json({ received, sequence }); }
    if (path.endsWith('/finish')) { await note('finish'); return json(job); }
    if (path === '/api/' + requestId) return json(job);
    if (path === '/api/files/uploads/' + transferId) return json({ job });
    throw Error('UNEXPECTED_OWNED_ROUTE');
  } });
  await client.connect(); return client;
} });
await startFileMcp({ forwarder });
