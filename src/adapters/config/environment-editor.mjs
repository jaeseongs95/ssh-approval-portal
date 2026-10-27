import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';

const messages = {
  conflict: '서버 ENV가 변경됐습니다. 현재 설정을 다시 불러온 뒤 수정해 주세요.',
  'validation-failed': 'ENV 검증에 실패했습니다. 입력 형식과 설정 조합을 확인해 주세요.',
  'invalid-value': '입력값에 사용할 수 없는 문자나 형식이 있습니다.',
  'invalid-fields': '이 화면에서 수정할 수 없는 설정입니다.',
  'restart-in-progress': '이미 재시작 중입니다. 결과를 확인해 주세요.',
  'confirmation-required': '변경 내용과 재시작 영향을 확인해 주세요.',
  'schedule-failed': '재시작을 예약하지 못했습니다. 서버 상태를 확인해 주세요.',
};
const refusal = message => Object.assign(Error(message), { publicMessage: message, refused: true });

export function environmentTransport(request, socketPath = '/run/ssh-approval-env.sock') {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); socket.setEncoding('utf8'); let data = '', ended = false;
    const fail = () => { if (!ended) { ended = true; socket.destroy(); reject(Object.assign(refusal('ENV 관리 연결을 확인할 수 없습니다. 저장·재시작 요청을 반복하지 말고 현재 상태를 조회해 주세요.'), { refused: false })); } };
    socket.setTimeout(15000, fail); socket.on('error', fail); socket.on('end', () => { if (!ended) fail(); });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8'); if (Buffer.byteLength(data) > 65536) return fail();
      if (!data.endsWith('\n')) return;
      try { const result = JSON.parse(data); ended = true; socket.destroy(); resolve(result); } catch { fail(); }
    });
  });
}

export function createEnvironmentEditor({ lifecycle, audit, transport = environmentTransport }) {
  let mutating = false;
  const call = async request => {
    const result = await transport(request);
    if (result.error) { const error = refusal(messages[result.error] ?? 'ENV 작업을 완료하지 못했습니다. 서버 관리자에게 상태 확인을 요청해 주세요.'); error.refused = true; throw error; }
    return result;
  };
  return {
    async get() {
      try { return await call({ action: 'read' }); }
      catch { return { available: false, message: 'ENV 편집 연결이 없습니다. 네이티브 서버에서 관리자 설정 도구를 활성화해 주세요. Docker는 호스트에서 ENV를 수정하고 컨테이너를 재생성합니다.' }; }
    },
    async mutate(action, body) {
      if (mutating) throw refusal('다른 ENV 작업이 진행 중입니다.');
      if (!['save', 'restart'].includes(action) || !body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(key => !['expectedRevision', 'changes', 'acknowledged'].includes(key)) ||
          !/^[a-f0-9]{64}$/.test(body.expectedRevision) || body.acknowledged !== true) throw refusal(messages['confirmation-required']);
      const state = lifecycle.snapshot();
      if (state.busy || state.pending || state.maintenance) throw refusal('실행 중·승인 대기 요청 또는 유지보수가 있습니다. 모두 종료한 뒤 다시 시도해 주세요.');
      mutating = true; let reserved = false;
      const owner = randomBytes(32).toString('hex');
      try {
        try { lifecycle.reserve(owner); reserved = true; } catch { throw refusal('진행 중인 요청이나 전송이 있습니다. 모두 종료한 뒤 다시 시도해 주세요.'); }
        // Record only setting names. Never audit input values, revisions or exception strings.
        try { audit({ action: 'environment-' + action + '-requested', changedFields: action === 'save' ? Object.keys(body.changes ?? {}).length : 0 }); }
        catch { throw refusal('감사 기록을 저장하지 못해 ENV 작업을 시작하지 않았습니다.'); }
        const result = await call({ action, ...body, ...(action === 'restart' ? { maintenanceOwner: owner } : {}) });
        try { audit({ action: 'environment-' + action + '-accepted' }); } catch { result.auditWarning = true; }
        // Restart remains reserved until the root timer replaces this process.
        if (action === 'restart' && result.accepted) reserved = false;
        return result;
      } catch (error) {
        // An ambiguous restart response may already have scheduled the root job.
        // Keep maintenance until process replacement; never admit competing SSH work.
        if (action === 'restart' && reserved && !error.refused) reserved = false;
        throw error;
      } finally { if (reserved) lifecycle.release(owner); mutating = false; }
    },
  };
}
