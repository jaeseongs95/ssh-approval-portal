export function createCardI18n(language = 'en') {
const korean = language.toLowerCase().startsWith('ko');
const locale = korean ? 'ko-KR' : 'en-US';
const en = {
  '대상 ID': 'Target ID', '설정 revision': 'Configuration revision', '호스트 키': 'Host key', '전체 대상': 'All targets',
  '대상 선택에 실패했습니다. 다시 열어 주세요.': 'Could not select the target. Reopen the file card.',
  '중계기': 'Bridge', '대상 서버': 'Target server', '서버 식별': 'Server identity',
  '승인 대기': 'Awaiting approval', '실행 중': 'Running', '완료': 'Completed', '실패': 'Failed', '거부됨': 'Denied', '만료됨': 'Expired',
  '요청이 거부되었습니다. 인증·만료·전송 상태를 확인하세요.': 'Request refused. Check authentication, expiration and transfer state.',
  '표시 시험 — 명령은 실행되지 않습니다': 'Display test — no commands will run', 'UI 전용 메타데이터를 받지 못했습니다': 'UI-only metadata was not received',
  '요청을 찾을 수 없습니다. 재시작으로 유실됐을 수 있습니다.': 'Request not found. It may have been lost after a restart.',
  '요청 정보': 'Request details', '요청': 'Request', '승인 만료': 'Approval expires', '실행할 명령': 'Command to execute', '파일 전송 내용': 'File transfer details',
  '방향': 'Direction', 'PC → 서버': 'PC → Server', '서버 → PC': 'Server → PC', '파일명': 'File name', '서버 경로': 'Remote path', '크기': 'Size', '바이트': 'bytes',
  'sudo 사용': 'Use sudo', '예': 'Yes', '아니요': 'No', '덮어쓰기': 'Overwrite', '실행 결과': 'Execution result', '파일 전송에 실패했습니다.': 'File transfer failed.',
  '승인·실행': 'Approve and run', '거부': 'Deny', '파일 저장': 'Save file', '파일 저장 링크를 받지 못했습니다.': 'No file download link was received.',
  '저장 취소 또는 미지원': 'Save cancelled or unsupported', '웹 승인 화면에서 파일을 저장하세요.': 'Save the file from the web approval page.',
  '연결이 끊겼습니다. 명령은 재실행하지 않습니다.': 'Connection lost. The command will not be executed again.',
  '파일 업로드 준비': 'Ready to upload', '파일 다운로드 준비': 'Ready to download', '서버의 절대 파일 경로': 'Absolute remote file path',
  ' sudo로 전송': ' Transfer using sudo', ' 기존 파일 덮어쓰기': ' Overwrite existing file', '최대': 'Maximum', '서버 반영은 승인 후 진행합니다.': 'The remote file changes only after approval.',
  '파일 전송 후 승인 요청': 'Send file and request approval', '다운로드 요청': 'Request download', '파일을 선택하고 크기 한도를 확인하세요.': 'Choose a file within the size limit.',
  '중계기 전송': 'Uploading to bridge', 'UI 동작은 클라이언트 검증 후 활성화됩니다.': 'UI actions are enabled after client verification.',
};
const t = value => korean ? value : en[value] ?? value;
const states = Object.fromEntries(Object.entries({ pending: '승인 대기', running: '실행 중', completed: '완료', failed: '실패', denied: '거부됨', expired: '만료됨' }).map(([key,value]) => [key,t(value)]));

return { t, korean, locale, states };
}
