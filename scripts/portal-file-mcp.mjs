import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPortalClient } from '../src/adapters/cli/portal-client.mjs';
import { loadFileManifest, createFileForwarder } from '../src/adapters/cli/file-forwarder.mjs';
import { validateLocalPath } from '../src/adapters/cli/local-files.mjs';

const fail = code => Object.assign(new Error(code), { code });
const capabilityArgs = z.strictObject({ capabilityId: z.string().regex(/^[a-f0-9]{48}$/) });
export async function startFileMcp({ forwarder, transport = new StdioServerTransport() }) {
  const server = new McpServer({ name: 'ssh-portal-local-files', version: '1.0.0' });
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.error ? { isError: true } : {}) });
  const wrap = callback => async args => {
    try { return result(await callback(args)); }
    catch { return result({ state: 'refused', error: 'CAPABILITY_REQUEST_REFUSED' }); }
  };
  server.registerTool('file_capabilities', { description: '고정된 파일 ID와 공개 이름을 확인합니다. PC 경로·원격 경로는 표시하지 않습니다.', inputSchema: z.strictObject({}), annotations: { readOnlyHint: true } }, wrap(args => forwarder.list(args)));
  for (const [name, action, description] of [
    ['file_upload', 'upload', '고정한 PC 파일을 해당 파일 ID의 서버 경로로 한 번 요청합니다. 기존 기록이 있으면 새 전송을 만들지 않습니다.'],
    ['file_download_request', 'request-download', '고정한 서버 파일의 다운로드 준비를 한 번 요청합니다. 준비 완료는 PC 저장 완료와 다릅니다.'],
    ['file_status', 'status', '같은 파일 ID의 기록과 알려진 전송·요청 상태를 읽습니다. 작업을 새로 만들지 않습니다.'],
    ['file_upload_resume', 'resume-upload', '같은 파일 ID에 기록된 전송 ID만 원래 바이트·대상·경로로 명시적으로 재개합니다.'],
    ['file_save', 'save', '같은 파일 ID의 준비된 결과를 고정 PC 경로에 검증·배타 저장합니다. 저장 결과가 불명확하면 재시도하지 않습니다.'],
  ]) server.registerTool(name, { description, inputSchema: capabilityArgs, annotations: { readOnlyHint: action === 'status', destructiveHint: action !== 'status', idempotentHint: false } }, wrap(args => forwarder.invoke(action, args)));
  await server.connect(transport);
  return server;
}
export async function main(argv = process.argv.slice(2), errorOutput = process.stderr, runCredential = execFileSync) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: 'boolean' }, manifest: { type: 'string' }, journal: { type: 'string' }, cloudflared: { type: 'string' },
    } });
    if (values.help && argv.length === 1) {
      errorOutput.write('사용법: node scripts/portal-file-mcp.mjs --manifest 절대설정경로 --journal 기존전용기록폴더 --cloudflared 기존실행경로\n모델 도구 입력은 고정 파일 ID만 받습니다. 인증은 기존 로그인 캐시를 사용하며, 자동 로그인·승인·경로 변경은 하지 않습니다. 결과 불명 기록은 지우거나 새 작업으로 재실행하지 마세요.\n');
      return 0;
    }
    if (values.help || positionals.length || !values.manifest || !values.journal || !values.cloudflared) throw fail('INVALID_ARGUMENTS');
    validateLocalPath(values.cloudflared);
    const manifest = await loadFileManifest(values.manifest);
    const forwarder = await createFileForwarder({ manifest, journalRoot: values.journal,
      openClient: async (origin, { timeoutMs, signal }) => {
        let token, client;
        try {
          token = runCredential(values.cloudflared, ['access', 'token', '--app=' + origin],
            { encoding: 'utf8', timeout: Math.min(30_000, timeoutMs), maxBuffer: 16386, killSignal: 'SIGKILL', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
          if (typeof token !== 'string') throw Error();
          client = createPortalClient({ origin, accessToken: token.replace(/\r?\n$/, ''), timeoutMs, signal });
          token = undefined; await client.connect(); return client;
        } catch {
          token = undefined; await client?.close().catch(() => {});
          throw fail('ACCESS_CREDENTIAL_UNAVAILABLE');
        }
      } });
    await startFileMcp({ forwarder }); return 0;
  } catch {
    errorOutput.write(JSON.stringify({ error: 'FILE_MCP_START_REFUSED' }) + '\n'); return 1;
  }
}
const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (invoked && pathToFileURL(invoked).href === import.meta.url) process.exitCode = await main();
