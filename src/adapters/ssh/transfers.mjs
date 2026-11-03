import { remotePath, windowsRemotePath, remoteBasename } from '../../domain/validation.mjs';
import { fileTargetBinding } from '../../domain/file-target-binding.mjs';
import { createSshTransport } from './vendor.mjs';

const fileFailures = new Map([
  ['PARENT_NOT_FOUND', '원격 상위 폴더가 없습니다. 관리자가 폴더를 준비한 뒤 새 전송을 요청하세요.'],
  ['FILE_NOT_FOUND', '원격 파일이 없습니다. 파일 위치를 확인한 뒤 새 전송을 요청하세요.'],
  ['PERMISSION_DENIED', '파일 작업 권한이 부족합니다. 관리자가 승인된 계정의 권한과 대상 상태를 확인하세요. 파일이 이미 반영됐을 수 있으므로 대상 상태를 확인하기 전 재전송하지 마세요.'],
  ['DESTINATION_EXISTS', '대상 파일이 이미 있어 덮어쓰지 않았습니다. 다른 경로를 선택하거나 덮어쓰기를 명시한 새 요청을 승인받으세요.'],
  ['UNSAFE_PATH', '안전하지 않은 경로나 파일 형식이 거부되었습니다. 심볼릭 링크가 없는 일반 파일 경로로 새 전송을 요청하세요.'],
  ['PATH_OUTSIDE_ALLOWED_ROOT', '대상 경로가 이 Windows 서버에 설정된 파일 허용 루트 밖입니다. allowedRoot 안의 경로를 사용하거나 관리자가 대상의 테스트 모드를 설정해야 합니다. 개별 승인만으로 경로 제한은 해제되지 않습니다.'],
  ['PATH_POLICY_UNSUPPORTED', '설치된 Windows 파일 헬퍼가 테스트 모드의 경로 제한 우회를 지원하는지 확인하지 못했습니다. 헬퍼를 갱신한 뒤 대상 상태를 확인하세요. 자동 재실행하지 않습니다.'],
  ['STAGING_UNAVAILABLE', '원격 임시 전송 영역을 사용할 수 없습니다. 관리자가 임시 영역의 상태와 권한을 확인한 뒤 새 전송을 요청하세요.'],
  ['FILE_CHANGED', '파일이 승인된 내용이나 상태와 달라 작업을 중단했습니다. 현재 파일을 확인한 뒤 새 전송을 요청하세요.'],
  ['FILE_TOO_LARGE', '파일이 전송 크기 제한을 초과했습니다. 제한 이내의 파일로 새 전송을 요청하세요.'],
  ['INVALID_REQUEST', '파일 작업 요청이 유효하지 않습니다. 요청 정보와 승인 내용을 확인한 뒤 새 전송을 요청하세요.'],
  ['OPERATION_FAILED', '파일 작업이 실패했습니다. 관리자가 보호된 서버 진단과 대상 상태를 확인하세요. 파일이 이미 반영됐을 수 있으므로 대상 상태를 확인하기 전 재전송하지 마세요. 자동으로 재시도하지 않습니다.'],
]);

class RemoteFileError extends Error {
  constructor(code = 'OPERATION_FAILED', allowedRoot) {
    super('Remote file operation failed'); this.code = code;
    if (code === 'PATH_OUTSIDE_ALLOWED_ROOT' && typeof allowedRoot === 'string') {
      try { windowsRemotePath(allowedRoot); this.allowedRoot = allowedRoot; } catch { /* Ignore invalid helper metadata. */ }
    }
  }
}

function fileFailure(error) {
  if (!(error instanceof RemoteFileError)) throw error;
  return { failed: true, texts: [`${error.code}: ${fileFailures.get(error.code)}`], data: { errorCode: error.code,
    ...(error.allowedRoot ? { allowedRoot: error.allowedRoot } : {}) } };
}

const cleanupUnconfirmed = transferId => ({ failed: true,
  texts: [`원격 임시파일 정리를 확인하지 못했습니다. 작업이 이미 반영됐거나 원래 대상에 임시자료가 남아 있을 수 있습니다. 관리자가 원래 대상과 전송 상태를 확인하기 전 재전송하지 마세요. 자동으로 재시도하지 않습니다. 전송 식별자: ${transferId}`],
  data: { errorCode: 'OPERATION_FAILED', remoteCleanup: 'unconfirmed', transferId } });

export class Transfers {
  constructor(registry, store, { platform = 'linux', helper = platform === 'windows' ? 'C:/ProgramData/ssh-approval-portal/windows-file-helper.ps1' : '/usr/local/libexec/ssh-approval-file-helper', remoteStage = platform === 'windows' ? 'C:/ProgramData/ssh-approval-transfer/incoming' : '/var/lib/ssh-approval-transfer/incoming', readProfile = 'aws-readonly', writeProfile = 'aws-local', transport = createSshTransport(registry), pathPolicy = async () => ({ bypassRoot: false }) } = {}) {
    if (!['linux', 'windows'].includes(platform)) throw Error('Unsupported remote platform');
    if (platform === 'windows') {
      windowsRemotePath(helper); windowsRemotePath(remoteStage);
      // These paths enter a command line or SFTP; keep configuration shell-neutral.
      if (![helper, remoteStage].every(path => /^[A-Za-z]:[\\/][A-Za-z0-9_./\\ -]+$/.test(path))) throw Error('Invalid installed helper paths');
      remoteStage = remoteStage.replaceAll('\\', '/');
    } else if (!/^\/[A-Za-z0-9_./-]+$/.test(helper) || !/^\/[A-Za-z0-9_./-]+$/.test(remoteStage)) throw Error('Invalid installed helper paths');
    if (typeof pathPolicy !== 'function') throw Error('Invalid file path policy provider');
    Object.assign(this, { store, helper, remoteStage, readProfile, writeProfile, transport, platform, pathPolicy });
  }
  validate(op) {
    (this.platform === 'windows' ? windowsRemotePath : remotePath)(op.remotePath);
  }
  async call(session, action, op) {
    // Only the composition root supplies this provider. Never trust operation input
    // to bypass a remote root; re-resolve authority for every non-cleanup call.
    const bypassRoot = this.platform === 'windows' && action !== 'cleanup' && (await this.pathPolicy(op))?.bypassRoot === true;
    const command = this.platform === 'windows' ? `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${this.helper}"` : `${op.elevate ? 'sudo -n ' : ''}${this.helper}`;
    const result = action === 'cleanup' && session.cleanup ? await session.cleanup() : await session.call(command, { action, id: op.artifactId, remotePath: op.remotePath, overwrite: op.overwrite, sha256: op.sha256, size: op.size, maxBytes: this.store.maxBytes,
      ...(this.platform === 'windows' ? { elevate: op.elevate === true, ...(bypassRoot ? { bypassRoot: true } : {}) } : {}) });
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new RemoteFileError(); }
    if (result.exitCode !== 0 || result.signal) {
      // Trust only the installed helper's failure code, never its text or extra fields.
      if (result.exitCode === 1 && !result.signal && data?.errorCode === 'PATH_OUTSIDE_ALLOWED_ROOT') this.observeRoot(data.allowedRoot);
      throw new RemoteFileError(result.exitCode === 1 && !result.signal && fileFailures.has(data?.errorCode) ? data.errorCode : undefined, data?.allowedRoot);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errorCode) throw new RemoteFileError();
    if (bypassRoot && data.rootPolicyApplied !== 'test-server-bypass') throw new RemoteFileError('PATH_POLICY_UNSUPPORTED');
    if (action === 'cleanup' && session.cleanup && data.cleaned !== true) throw new RemoteFileError();
    if (action === 'policy') this.observeRoot(data.allowedRoot);
    return data;
  }
  observeRoot(allowedRoot) {
    try { windowsRemotePath(allowedRoot); this.rootObservation = { allowedRoot, observedAt: Date.now() }; } catch { /* Invalid helper metadata is never published. */ }
  }
  async checkPathPolicy(session, op) {
    if (this.platform !== 'windows' || (await this.pathPolicy(op))?.bypassRoot !== true) return;
    let policy;
    try { policy = await this.call(session, 'policy', op); }
    catch (error) {
      // Older helpers reject the newly introduced read-only policy action.
      if (error instanceof RemoteFileError && error.code === 'INVALID_REQUEST') throw new RemoteFileError('PATH_POLICY_UNSUPPORTED');
      throw error;
    }
    if (policy.protocol !== 'file-path-policy-v1' || policy.rootPolicyApplied !== 'test-server-bypass') throw new RemoteFileError('PATH_POLICY_UNSUPPORTED');
    try { windowsRemotePath(policy.allowedRoot); } catch { throw new RemoteFileError('PATH_POLICY_UNSUPPORTED'); }
  }
  async upload(op, beforeDispatch) {
    this.validate(op);
    const item = this.store.get(op.artifactId);
    const binding = fileTargetBinding(op);
    if (binding ? item.fileTargetBound !== true || item.targetId !== binding.targetId || item.targetRevision !== binding.targetRevision : item.fileTargetBound === true) throw Error('Upload target does not match frozen operation');
    if (item.sha256 !== op.sha256 || item.size !== op.size || item.remotePath !== op.remotePath || item.overwrite !== op.overwrite || item.elevate !== op.elevate) throw Error('Upload does not match frozen operation');
    const session = await this.transport.connect(this.writeProfile, { beforeDispatch, cleanup: { platform: this.platform, helper: this.helper, id: item.id } });
    const fd = await this.store.verified(item.id);
    const staged = { ...op, artifactId: item.id };
    let needsCleanup = false;
    try {
      await this.checkPathPolicy(session, staged);
      // Check the connected token before uploading bytes; publish checks it again.
      if (this.platform === 'windows' && op.elevate) {
        const authorization = await this.call(session, 'authorize', staged);
        if (authorization.authorized !== true || authorization.elevated !== true) throw new RemoteFileError();
      }
      // Approval has already reserved execution; the helper alone publishes the destination.
      needsCleanup = true;
      await session.upload(fd.createReadStream({ start: 0, autoClose: false }), `${this.remoteStage}/${item.id}.part`, { maxBytes: this.store.maxBytes });
      const data = await this.call(session, 'publish', staged);
      return { failed: false, texts: ['Upload completed'], data };
    } catch (error) {
      return fileFailure(error);
    } finally {
      try { await fd.close(); }
      finally {
        if (needsCleanup) {
          try { await this.call(session, 'cleanup', { ...staged, elevate: false }); }
          catch { if (session.cleanup) return cleanupUnconfirmed(item.id); }
        }
      }
    }
  }
  async download(op, beforeDispatch) {
    this.validate(op);
    const binding = fileTargetBinding(op);
    const item = this.store.reserveDownload({ fileName: remoteBasename(op.remotePath, this.platform), remotePath: op.remotePath, elevate: op.elevate,
      ...(binding ? { ...binding, fileTargetBound: true } : {}) });
    let session;
    const staged = { ...op, artifactId: item.id };
    try {
      session = await this.transport.connect(op.elevate ? this.writeProfile : this.readProfile, { beforeDispatch, cleanup: { platform: this.platform, helper: this.helper, id: item.id } });
      await this.checkPathPolicy(session, staged);
      const metadata = await this.call(session, 'snapshot', staged);
      const ready = await this.store.receiveDownload(item.id, metadata, destination => session.download(`${this.remoteStage}/${item.id}.part`, destination, { maxBytes: this.store.maxBytes }));
      return { failed: false, texts: ['Server file ready. It has not been saved to your device or delivered to the agent. Use the file card or the administrator page to save it.'], data: { artifactId: ready.id, fileName: ready.fileName, size: ready.size, sha256: ready.sha256 } };
    } catch (err) { await this.store.remove(item.id); return fileFailure(err); }
    finally {
      if (session) {
        try { await this.call(session, 'cleanup', { ...staged, elevate: false }); }
        catch { if (session.cleanup) return cleanupUnconfirmed(item.id); }
      }
    }
  }
}

export const createTransferExecutor = (registry, store, options) => new Transfers(registry, store, options);
