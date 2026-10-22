import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { createPortalClient } from '../src/adapters/cli/portal-client.mjs';

export async function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout, errorOutput = process.stderr) {
  let client;
  try {
    const { values, positionals: args } = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: 'boolean' }, origin: { type: 'string' }, 'access-token-stdin': { type: 'boolean' }, target: { type: 'string' }, sudo: { type: 'boolean' }, overwrite: { type: 'boolean' }, confirm: { type: 'boolean' } } });
    if (values.help === true && argv.length === 1) {
      output.write('사용법: node scripts/portal-client.mjs --origin https://관리자호스트 --access-token-stdin <명령>\n명령: targets | pending | status ID | transfer ID | approve ID --confirm | deny ID --confirm | upload 절대로컬경로 원격경로 [--target ID] [--sudo] [--overwrite] | resume-upload ID 절대로컬경로 원격경로 [--target ID] [--sudo] [--overwrite] | request-download 원격경로 [--target ID] [--sudo] | save ID 절대로컬경로\nAccess 사용자 토큰 한 줄을 stdin으로 전달하세요. 토큰을 인수·로그·채팅에 넣지 마세요. 승인 전 pending과 서버 준비 completed는 PC 저장 saved와 다릅니다. 결과가 불명확하면 같은 ID를 조회하세요. 재개는 같은 파일 바이트·원래 대상/경로/플래그가 일치하는 같은 전송 ID에만 명시적으로 수행합니다. 새 업로드나 승인을 자동 반복하지 않습니다.\n');
      return 0;
    }
    const count = { targets: 1, pending: 1, status: 2, transfer: 2, approve: 2, deny: 2, 'request-download': 2, upload: 3, 'resume-upload': 4, save: 3 };
    if (!values.origin || values['access-token-stdin'] !== true || args.length !== count[args[0]] ||
        (values.confirm && !['approve', 'deny'].includes(args[0])) ||
        (values.overwrite && !['upload', 'resume-upload'].includes(args[0])) ||
        ((values.target || values.sudo) && !['upload', 'resume-upload', 'request-download'].includes(args[0]))) throw Error('INVALID_ARGUMENTS');
    const parts = []; let length = 0;
    for await (const part of input) { length += Buffer.byteLength(part); if (length > 16386) throw Error('INVALID_ACCESS_CREDENTIAL'); parts.push(Buffer.from(part)); }
    const token = Buffer.concat(parts).toString('utf8').replace(/\r?\n$/, '');
    client = createPortalClient({ origin: values.origin, accessToken: token });
    await client.connect();
    const destination = { ...(values.target ? { target: values.target } : {}), elevate: values.sudo === true };
    let result;
    if (['targets', 'pending'].includes(args[0])) result = await client[args[0]]();
    else if (['status', 'transfer'].includes(args[0])) result = await client[args[0]](args[1]);
    else if (['approve', 'deny'].includes(args[0])) result = await client.decide(args[1], args[0], values.confirm === true);
    else if (args[0] === 'request-download') result = await client.requestDownload({ ...destination, remotePath: args[1] });
    else if (args[0] === 'save') result = await client.save(args[1], args[2]);
    else if (args[0] === 'resume-upload') result = await client.resumeUpload(args[1], args[2], { ...destination, remotePath: args[3], overwrite: values.overwrite === true });
    else result = await client.upload(args[1], { ...destination, remotePath: args[2], overwrite: values.overwrite === true }, record => errorOutput.write(JSON.stringify(record) + '\n'));
    output.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const code = /^[A-Z_]{3,64}$/.test(error.code ?? '') ? error.code : 'CLI_REQUEST_FAILED';
    errorOutput.write(JSON.stringify({ error: code, ...(error.requestId ? { requestId: error.requestId } : {}), ...(error.transferId ? { transferId: error.transferId } : {}) }) + '\n'); return 1;
  } finally { await client?.close().catch(() => {}); }
}

const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (invoked && pathToFileURL(invoked).href === import.meta.url) process.exitCode = await main();
