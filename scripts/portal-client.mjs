import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPortalClient, validateOutputOptions, validateUploadExpectation } from '../src/adapters/cli/portal-client.mjs';
import { validateOrigin } from '../src/adapters/config/settings.mjs';
import { validateLocalPath } from '../src/adapters/cli/local-files.mjs';
import { idValid, remotePath as validateRemotePath } from '../src/domain/validation.mjs';

export async function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout, errorOutput = process.stderr, runCredential = execFileSync) {
  let client;
  try {
    const { values, positionals: args } = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: 'boolean' }, origin: { type: 'string' }, 'access-token-stdin': { type: 'boolean' }, cloudflared: { type: 'string' }, target: { type: 'string' }, sudo: { type: 'boolean' }, overwrite: { type: 'boolean' }, confirm: { type: 'boolean' }, offset: { type: 'string' }, limit: { type: 'string' }, format: { type: 'string' }, 'expect-size': { type: 'string' }, 'expect-sha256': { type: 'string' } } });
    if (values.help === true && argv.length === 1) {
      output.write('사용법: node scripts/portal-client.mjs --origin https://관리자호스트 (--access-token-stdin | --cloudflared 절대실행경로) <명령>\n명령: targets | pending | status ID | output ID [--offset 바이트] [--limit 4..16384] [--format text|json] | transfer ID | approve ID --confirm | deny ID --confirm | upload 절대로컬경로 원격경로 [--target ID] [--sudo] [--overwrite] [--expect-size 바이트 --expect-sha256 SHA256] | resume-upload ID 절대로컬경로 원격경로 [--target ID] [--sudo] [--overwrite] | request-download 원격경로 [--target ID] [--sudo] | save ID 절대로컬경로\noutput은 저장 본문 한 페이지만 명시적으로 읽습니다. 다음 페이지는 nextOffset으로 조회하고, wholeSha256Verified는 처음부터 끝까지 한 번에 읽어 전체 해시를 검증했을 때만 true입니다. 만료된 출력을 복구하려고 명령을 다시 실행하지 마세요. 기대 크기·SHA256을 지정하면 같은 업로드 스냅샷이 두 값과 일치할 때만 원격 업로드를 시작합니다. 두 옵션은 upload에서 함께 사용합니다. stdin 모드는 Access 사용자 토큰 한 줄을 전달합니다. cloudflared 모드는 기존 로그인 캐시만 읽으며 로그인이 필요하면 별도로 진행하세요. 토큰을 인수·로그·채팅에 넣지 마세요. 승인 전 pending과 서버 준비 completed는 PC 저장 saved와 다릅니다. 결과가 불명확하면 같은 ID를 조회하세요. 재개는 같은 파일 바이트·원래 대상/경로/플래그가 일치하는 같은 전송 ID에만 명시적으로 수행합니다. 새 업로드나 승인을 자동 반복하지 않습니다.\n');
      return 0;
    }
    const count = { targets: 1, pending: 1, status: 2, output: 2, transfer: 2, approve: 2, deny: 2, 'request-download': 2, upload: 3, 'resume-upload': 4, save: 3 };
    const cached = values.cloudflared !== undefined;
    if (values.help === true || !values.origin || cached === (values['access-token-stdin'] === true) || args.length !== count[args[0]] ||
        (values.confirm && !['approve', 'deny'].includes(args[0])) ||
        (values.overwrite && !['upload', 'resume-upload'].includes(args[0])) ||
        ((values.target || values.sudo) && !['upload', 'resume-upload', 'request-download'].includes(args[0])) ||
        (args[0] !== 'output' && [values.offset, values.limit, values.format].some(value => value !== undefined))) throw Error('INVALID_ARGUMENTS');
    validateOrigin(values.origin);
    if (['status', 'output', 'transfer', 'approve', 'deny', 'save', 'resume-upload'].includes(args[0]) && !idValid(args[1])) throw Object.assign(Error(), { code: 'INVALID_REQUEST_ID' });
    if (['approve', 'deny'].includes(args[0]) && values.confirm !== true) throw Object.assign(Error(), { code: 'EXPLICIT_OWNER_DECISION_REQUIRED' });
    if (values.target !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(values.target)) throw Object.assign(Error(), { code: 'INVALID_TARGET' });
    let outputOptions;
    if (args[0] === 'output') {
      if ([values.offset, values.limit].some(value => value !== undefined && !/^(0|[1-9][0-9]{0,15})$/.test(value))) throw Object.assign(Error(), { code: 'INVALID_OUTPUT_OPTIONS' });
      outputOptions = validateOutputOptions({ ...(values.offset === undefined ? {} : { offsetBytes: Number(values.offset) }), ...(values.limit === undefined ? {} : { maxBytes: Number(values.limit) }), ...(values.format === undefined ? {} : { format: values.format }) });
    }
    let expectedSource;
    if (values['expect-size'] !== undefined || values['expect-sha256'] !== undefined) {
      if (args[0] !== 'upload' || values['expect-size'] === undefined || values['expect-sha256'] === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(values['expect-size'])) throw Object.assign(Error(), { code: 'INVALID_UPLOAD_EXPECTATION' });
      expectedSource = validateUploadExpectation({ size: Number(values['expect-size']), sha256: values['expect-sha256'] });
    }
    if (cached) validateLocalPath(values.cloudflared);
    const localIndex = { upload: 1, 'resume-upload': 2, save: 2 }[args[0]];
    const remoteIndex = { upload: 2, 'resume-upload': 3, 'request-download': 1 }[args[0]];
    if (localIndex !== undefined) validateLocalPath(args[localIndex]);
    if (remoteIndex !== undefined) validateRemotePath(args[remoteIndex]);
    let token;
    if (cached) {
      try { token = runCredential(values.cloudflared, ['access', 'token', '--app=' + values.origin], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16386, killSignal: 'SIGKILL', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { throw Object.assign(Error(), { code: 'ACCESS_CREDENTIAL_UNAVAILABLE' }); }
      if (typeof token !== 'string') throw Object.assign(Error(), { code: 'INVALID_ACCESS_CREDENTIAL' });
      token = token.replace(/\r?\n$/, '');
    } else {
      const parts = []; let length = 0;
      for await (const part of input) { length += Buffer.byteLength(part); if (length > 16386) throw Error('INVALID_ACCESS_CREDENTIAL'); parts.push(Buffer.from(part)); }
      token = Buffer.concat(parts).toString('utf8').replace(/\r?\n$/, '');
    }
    client = createPortalClient({ origin: values.origin, accessToken: token });
    await client.connect();
    const destination = { ...(values.target ? { target: values.target } : {}), elevate: values.sudo === true };
    let result;
    if (['targets', 'pending'].includes(args[0])) result = await client[args[0]]();
    else if (['status', 'transfer'].includes(args[0])) result = await client[args[0]](args[1]);
    else if (args[0] === 'output') result = await client.output(args[1], outputOptions);
    else if (['approve', 'deny'].includes(args[0])) result = await client.decide(args[1], args[0], values.confirm === true);
    else if (args[0] === 'request-download') result = await client.requestDownload({ ...destination, remotePath: args[1] });
    else if (args[0] === 'save') result = await client.save(args[1], args[2]);
    else if (args[0] === 'resume-upload') result = await client.resumeUpload(args[1], args[2], { ...destination, remotePath: args[3], overwrite: values.overwrite === true });
    else result = await client.upload(args[1], { ...destination, remotePath: args[2], overwrite: values.overwrite === true }, record => errorOutput.write(JSON.stringify(record) + '\n'), expectedSource);
    output.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const code = /^[A-Z_]{3,64}$/.test(error.code ?? '') ? error.code : 'CLI_REQUEST_FAILED';
    errorOutput.write(JSON.stringify({ error: code, ...(error.requestId ? { requestId: error.requestId } : {}), ...(error.transferId ? { transferId: error.transferId } : {}), ...(error.outputId ? { outputId: error.outputId } : {}) }) + '\n'); return 1;
  } finally { await client?.close().catch(() => {}); }
}

const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (invoked && pathToFileURL(invoked).href === import.meta.url) process.exitCode = await main();
