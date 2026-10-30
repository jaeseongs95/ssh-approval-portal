import { posix } from 'node:path';
import { remotePath } from '../../domain/validation.mjs';
import { fileTargetBinding } from '../../domain/file-target-binding.mjs';
import { createSshTransport } from './vendor.mjs';

const fileFailures = new Map([
  ['PARENT_NOT_FOUND', '원격 상위 폴더가 없습니다. 관리자가 폴더를 준비한 뒤 새 전송을 요청하세요.'],
  ['FILE_NOT_FOUND', '원격 파일이 없습니다. 파일 위치를 확인한 뒤 새 전송을 요청하세요.'],
  ['PERMISSION_DENIED', '파일 작업 권한이 부족합니다. 관리자가 승인된 계정의 권한과 대상 상태를 확인하세요. 파일이 이미 반영됐을 수 있으므로 대상 상태를 확인하기 전 재전송하지 마세요.'],
  ['DESTINATION_EXISTS', '대상 파일이 이미 있어 덮어쓰지 않았습니다. 다른 경로를 선택하거나 덮어쓰기를 명시한 새 요청을 승인받으세요.'],
  ['UNSAFE_PATH', '안전하지 않은 경로나 파일 형식이 거부되었습니다. 심볼릭 링크가 없는 일반 파일 경로로 새 전송을 요청하세요.'],
  ['STAGING_UNAVAILABLE', '원격 임시 전송 영역을 사용할 수 없습니다. 관리자가 임시 영역의 상태와 권한을 확인한 뒤 새 전송을 요청하세요.'],
  ['FILE_CHANGED', '파일이 승인된 내용이나 상태와 달라 작업을 중단했습니다. 현재 파일을 확인한 뒤 새 전송을 요청하세요.'],
  ['FILE_TOO_LARGE', '파일이 전송 크기 제한을 초과했습니다. 제한 이내의 파일로 새 전송을 요청하세요.'],
  ['INVALID_REQUEST', '파일 작업 요청이 유효하지 않습니다. 요청 정보와 승인 내용을 확인한 뒤 새 전송을 요청하세요.'],
  ['OPERATION_FAILED', '파일 작업이 실패했습니다. 관리자가 보호된 서버 진단과 대상 상태를 확인하세요. 파일이 이미 반영됐을 수 있으므로 대상 상태를 확인하기 전 재전송하지 마세요. 자동으로 재시도하지 않습니다.'],
]);

class RemoteFileError extends Error {
  constructor(code = 'OPERATION_FAILED') { super('Remote file operation failed'); this.code = code; }
}

function fileFailure(error) {
  if (!(error instanceof RemoteFileError)) throw error;
  return { failed: true, texts: [`${error.code}: ${fileFailures.get(error.code)}`], data: { errorCode: error.code } };
}

export class Transfers {
  constructor(registry, store, { helper = '/usr/local/libexec/ssh-approval-file-helper', remoteStage = '/var/lib/ssh-approval-transfer/incoming', readProfile = 'aws-readonly', writeProfile = 'aws-local', transport = createSshTransport(registry) } = {}) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(helper) || !/^\/[A-Za-z0-9_./-]+$/.test(remoteStage)) throw Error('Invalid installed helper paths');
    Object.assign(this, { store, helper, remoteStage, readProfile, writeProfile, transport });
  }
  async call(session, action, op) {
    const command = `${op.elevate ? 'sudo -n ' : ''}${this.helper}`;
    const result = await session.call(command, { action, id: op.artifactId, remotePath: op.remotePath, overwrite: op.overwrite, sha256: op.sha256, size: op.size, maxBytes: this.store.maxBytes });
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new RemoteFileError(); }
    if (result.exitCode !== 0 || result.signal) {
      // Trust only the installed helper's failure code, never its text or extra fields.
      throw new RemoteFileError(result.exitCode === 1 && !result.signal && fileFailures.has(data?.errorCode) ? data.errorCode : undefined);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errorCode) throw new RemoteFileError();
    return data;
  }
  async upload(op, beforeDispatch) {
    const item = this.store.get(op.artifactId);
    const binding = fileTargetBinding(op);
    if (binding ? item.fileTargetBound !== true || item.targetId !== binding.targetId || item.targetRevision !== binding.targetRevision : item.fileTargetBound === true) throw Error('Upload target does not match frozen operation');
    if (item.sha256 !== op.sha256 || item.size !== op.size || item.remotePath !== op.remotePath || item.overwrite !== op.overwrite || item.elevate !== op.elevate) throw Error('Upload does not match frozen operation');
    const session = await this.transport.connect(this.writeProfile, { beforeDispatch });
    const fd = await this.store.verified(item.id);
    const staged = { ...op, artifactId: item.id };
    try {
      // Approval has already reserved execution; the helper alone publishes the destination.
      await session.upload(fd.createReadStream({ start: 0, autoClose: false }), `${this.remoteStage}/${item.id}.part`, { maxBytes: this.store.maxBytes });
      const data = await this.call(session, 'publish', staged);
      return { failed: false, texts: ['Upload completed'], data };
    } catch (error) {
      return fileFailure(error);
    } finally {
      try { await fd.close(); }
      finally { await this.call(session, 'cleanup', { ...staged, elevate: false }).catch(() => {}); }
    }
  }
  async download(op, beforeDispatch) {
    remotePath(op.remotePath);
    const binding = fileTargetBinding(op);
    const item = this.store.reserveDownload({ fileName: posix.basename(op.remotePath), remotePath: op.remotePath, elevate: op.elevate,
      ...(binding ? { ...binding, fileTargetBound: true } : {}) });
    let session;
    const staged = { ...op, artifactId: item.id };
    try {
      session = await this.transport.connect(op.elevate ? this.writeProfile : this.readProfile, { beforeDispatch });
      const metadata = await this.call(session, 'snapshot', staged);
      const ready = await this.store.receiveDownload(item.id, metadata, destination => session.download(`${this.remoteStage}/${item.id}.part`, destination, { maxBytes: this.store.maxBytes }));
      return { failed: false, texts: ['Server file ready. It has not been saved to your device or delivered to the agent. Use the file card or the administrator page to save it.'], data: { artifactId: ready.id, fileName: ready.fileName, size: ready.size, sha256: ready.sha256 } };
    } catch (err) { await this.store.remove(item.id); return fileFailure(err); }
    finally { if (session) await this.call(session, 'cleanup', { ...staged, elevate: false }).catch(() => {}); }
  }
}

export const createTransferExecutor = (registry, store, options) => new Transfers(registry, store, options);
