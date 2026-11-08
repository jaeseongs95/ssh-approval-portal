import { resolveLocale, messageCatalog, translate, createFormatters } from './locale.js';
export const webCatalogs = messageCatalog({
  '위험 평가 중': 'Assessing risk', '실행 결과 불명': 'Execution outcome unknown',
  '등록됨': 'Registered', '사용 중지': 'Disabled',
  '보관 중': 'Retained', '평가 중': 'Assessing', '결과 불명': 'Outcome unknown',
  '실행 중인 요청이 없습니다': 'No running requests',
  '승인 후 실행 중인 명령과 파일 전송이 표시됩니다.': 'Approved commands and file transfers in progress appear here.',
  '대상 ID': 'Target ID', '설정 revision': 'Configuration revision', '호스트 키': 'Host key', '전체 대상': 'All targets',
  '대상 선택에 실패했습니다. 다시 열어 주세요.': 'Could not select the target. Reopen the file card.',
  '중계기': 'Bridge', '대상 서버': 'Target server', '서버 식별': 'Server identity',
  '실행 대기': 'Queued for execution', '승인 대기': 'Awaiting approval', '실행 중': 'Running', '완료': 'Completed', '실패': 'Failed', '거부': 'Denied', '만료': 'Expired',
  '명령 실행': 'Command', '파일 업로드': 'File upload', '파일 다운로드': 'File download', '요청 실패': 'Request failed',
  '요청': 'Request', '처리 완료': 'Finished', '승인·실행': 'Approve and run', '실행 결과': 'Execution result', '파일 저장': 'Save file',
  '대기 중인 요청이 없습니다': 'No pending requests', '새 승인 요청이 들어오면 여기에 표시됩니다.': 'New approval requests will appear here.',
  '아직 승인 이력이 없습니다': 'No approval history yet', '승인·거부된 요청의 상태와 결과가 여기에 표시됩니다.': 'Statuses and results of processed requests will appear here.',
  '연결됨': 'Connected', '마지막 갱신': 'Last refreshed', '10초마다 갱신': 'Refreshes every 10 seconds', '연결 확인 필요': 'Check connection',
  '요청 목록을 연결해 주세요': 'Connect to view requests', '관리자 토큰을 입력하고 요청 조회를 누르세요.': 'Enter your administrator token and refresh requests.',
  '처리 이력을 한눈에': 'Your approval history', '실행 중인 요청부터 완료된 결과까지 확인할 수 있습니다.': 'View running requests and completed results.', '관리자 토큰': 'Administrator token',
  '본인 계정으로 연결됨': 'Connected with your account', 'Cloudflare Access에서 확인한 본인 계정으로 요청을 처리합니다.': 'Manage requests with your owner account verified by Cloudflare Access.',
  '로그인이 만료되었거나 접근할 수 없습니다. 다시 로그인해 주세요.': 'Your session expired or access was denied. Please sign in again.',
  '로그아웃되었습니다.': 'You have signed out.',
  'SSO에서 확인한 본인 계정으로 요청을 처리합니다.': 'Manage requests with your owner account verified by SSO.',
  'JSON 형식으로 요청해 주세요.': 'Send a JSON request.',
  'ENV 변경 내용이 너무 큽니다.': 'ENV changes exceed the size limit.',
  '잘못된 JSON 형식입니다.': 'Invalid JSON format.',
  'ENV 작업을 완료하지 못했습니다. 현재 상태를 다시 조회해 주세요.': 'ENV operation failed. Read the current state again.',
  '다른 ENV 작업이 진행 중입니다.': 'Another ENV operation is in progress.',
  '실행 중·승인 대기 요청 또는 유지보수가 있습니다. 모두 종료한 뒤 다시 시도해 주세요.': 'Running or pending requests or maintenance are active. Finish all work and try again.',
  '진행 중인 요청이나 전송이 있습니다. 모두 종료한 뒤 다시 시도해 주세요.': 'Requests or file transfers are in progress. Finish all work and try again.',
  '감사 기록을 저장하지 못해 ENV 작업을 시작하지 않았습니다.': 'Could not write the audit log; ENV operation was not started.',
  '서버 ENV가 변경됐습니다. 현재 설정을 다시 불러온 뒤 수정해 주세요.': 'Server ENV changed. Load current settings before editing.',
  'ENV 검증에 실패했습니다. 입력 형식과 설정 조합을 확인해 주세요.': 'ENV validation failed. Check value formats and setting combinations.',
  '입력값에 사용할 수 없는 문자나 형식이 있습니다.': 'An input contains unsupported characters or format.',
  '이 화면에서 수정할 수 없는 설정입니다.': 'This setting cannot be edited on this page.',
  '이미 재시작 중입니다. 결과를 확인해 주세요.': 'A restart is already in progress. Check its outcome.',
  '변경 내용과 재시작 영향을 확인해 주세요.': 'Confirm the changes and restart impact.',
  '재시작을 예약하지 못했습니다. 서버 상태를 확인해 주세요.': 'Could not schedule restart. Check server state.',
  'ENV 관리 연결을 확인할 수 없습니다. 저장·재시작 요청을 반복하지 말고 현재 상태를 조회해 주세요.': 'ENV management connection unavailable. Do not repeat save or restart; read current state.',
  'ENV 작업을 완료하지 못했습니다. 서버 관리자에게 상태 확인을 요청해 주세요.': 'ENV operation failed. Ask the server administrator to check its state.',
});
export function createWebI18n(language = 'en') {
const { korean, locale, messageLanguage, dir } = resolveLocale(language);

const t = (value, values) => translate(webCatalogs, language, value, values);
const states = Object.fromEntries(Object.entries({ pending: '승인 대기', queued: '실행 대기', evaluating: '위험 평가 중', unknown: '실행 결과 불명', running: '실행 중', completed: '완료', failed: '실패', denied: '거부', expired: '만료' }).map(([key,value]) => [key,t(value)]));
const kinds = Object.fromEntries(Object.entries({ command: '명령 실행', upload: '파일 업로드', download: '파일 다운로드' }).map(([key,value]) => [key,t(value)]));
return { t, korean, locale, messageLanguage, dir, ...createFormatters(locale), states, kinds };
}
