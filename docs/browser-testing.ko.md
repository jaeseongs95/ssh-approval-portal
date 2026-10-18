# 브라우저 호환성 검사

기존 Playwright 1.62.1과 Node 테스트 runner를 사용합니다. 의존성을 추가하지 않습니다. 제품 코드와 서버 설정을 변경하지 않고 loopback fixture에서 Chromium·Firefox·WebKit에 같은 브라우저 검사를 실행합니다.

브라우저 엔진을 설치한 경로를 PLAYWRIGHT_BROWSERS_PATH로 지정합니다. Windows PowerShell 예시입니다.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = '<엔진 설치 디렉터리>'
node node_modules/playwright/cli.js install firefox webkit
$env:SOLID_CHROMIUM_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:UI_TEST_RESULTS = '<검사 결과 디렉터리>'
node test/browser/run.mjs all
```

하나만 실행할 때는 all 대신 chromium, firefox, webkit을 지정합니다. 기존 npm run test:browser는 Chromium 기본값을 유지하며 UI_TEST_BROWSER로 엔진을 선택할 수도 있습니다. 지정한 엔진 실행에 실패하면 다른 엔진으로 대체하지 않고 실패로 기록합니다. 결과 디렉터리에는 엔진별 버전·실행 경로·종료 코드·검사 합계·원시 로그·화면을 남깁니다.

승인·이력·명령 관리·ENV UI 회귀와 7개 화면 크기, 페이지·목록·긴 명령·출력 스크롤을 검사합니다. 합성 요청·모델·ENV 응답을 사용하는 경계는 실제 서버 및 실제 인증 검증과 구분합니다.

WebKit은 Safari가 사용하는 엔진 계열의 Playwright 테스트 빌드이며 실제 macOS/iOS Safari 자체는 아닙니다. Firefox는 isMobile 에뮬레이션을 지원하지 않고, WebKit의 모바일 모드는 휠 입력을 지원하지 않습니다. 두 엔진은 모바일 크기의 viewport와 터치 옵션으로 배치·휠 스크롤을 검사합니다. Chromium은 isMobile 옵션도 사용합니다. 모바일 Safari의 터치 제스처를 검증했다고 주장하지 않습니다. 모바일 실기기는 이번 검사에서 제외합니다.

공식 문서: [지원 브라우저](https://playwright.dev/docs/browsers), [모바일 에뮬레이션](https://playwright.dev/docs/emulation).

휠 입력은 브라우저별 단일 입력 이동량 제한을 고려해 반복하며 끝 도달·내용 보존·고정 헤더를 판정합니다. 키보드 초점 보존 검사는 클릭 시 초점 부여가 브라우저마다 다른 점을 피하도록 초점을 먼저 두고 Enter로 실행합니다.
