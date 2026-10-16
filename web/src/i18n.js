export function createWebI18n(language = 'en') {
const korean = language.toLowerCase().startsWith('ko');
const locale = korean ? 'ko-KR' : 'en-US';
const en = {
  '대상 ID': 'Target ID', '설정 revision': 'Configuration revision', '호스트 키': 'Host key', '전체 대상': 'All targets',
  '대상 선택에 실패했습니다. 다시 열어 주세요.': 'Could not select the target. Reopen the file card.',
  '중계기': 'Bridge', '대상 서버': 'Target server', '서버 식별': 'Server identity',
  '승인 대기': 'Awaiting approval', '실행 중': 'Running', '완료': 'Completed', '실패': 'Failed', '거부': 'Denied', '만료': 'Expired',
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
};
const t = value => korean ? value : en[value] ?? value;
const states = Object.fromEntries(Object.entries({ pending: '승인 대기', running: '실행 중', completed: '완료', failed: '실패', denied: '거부', expired: '만료' }).map(([key,value]) => [key,t(value)]));
const kinds = Object.fromEntries(Object.entries({ command: '명령 실행', upload: '파일 업로드', download: '파일 다운로드' }).map(([key,value]) => [key,t(value)]));
return { t, korean, locale, states, kinds };
}
