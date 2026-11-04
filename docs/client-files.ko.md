# PC 파일 전송 클라이언트 2.0.0

이 클라이언트는 PC 파일을 직접 읽어 owner 인증 HTTPS로 서버의 임시 보관소에 올립니다. 완료되면 UUID 한 개만 반환합니다. 파일 바이트·base64·인증 토큰을 모델 인자나 대화에 넣지 않습니다. 이후 복사·이동 등은 기존 원격 MCP 연결에 UUID를 전달해 요청합니다. 원격 MCP 연결을 추가하지 않습니다.

클라이언트의 upload는 임시 보관까지만 수행합니다. SSH 대상·목적지 경로를 받지 않으며, 원격 파일 반영이나 소유자 승인을 대신하지 않습니다.

## 실행 준비

Node.js 24.2 이상인 24.x와 신뢰하는 기존 cloudflared 실행 파일이 필요합니다. 이 배포본은 Node·cloudflared·인증 정보를 포함하지 않습니다. npm 의존성·전역 설치·설치 프로그램은 필요 없습니다. 기존 cloudflared owner 로그인 캐시만 사용하며 로그인이나 설치를 자동 실행하지 않습니다.

tar.gz 또는 zip을 새 작업 폴더에 풀고 그 폴더에서 아래 명령을 실행합니다. 예시 origin과 파일 경로는 실제 허용 대상으로 바꿉니다. cloudflared는 절대 경로로 지정할 수 있고, 생략하면 PORTAL_CLOUDFLARED와 PATH 순서로 기존 실행 파일을 확인합니다.

```powershell
$portalFiles = @(
  'scripts/portal-files.mjs',
  '--origin', 'https://approve.example.test',
  '--cloudflared', 'C:/tools/cloudflared.exe'
)
node @portalFiles doctor
node @portalFiles upload --file 'C:/work/package.tar.gz' --operation-key 'package-upload-20261104-r1'
```

doctor는 기존 owner 인증과 연결 상태만 확인합니다. 파일 전송·SSH 실행·승인·설치를 하지 않습니다. 캐시가 만료됐다면 소유자가 해당 origin의 기존 로그인 절차를 완료해야 합니다. 토큰 값을 복사하거나 에이전트에게 전달하지 않습니다.

operation-key는 호출자가 정하는 안정된 16~128자 식별자이며 영문·숫자·점·밑줄·콜론·하이픈을 사용할 수 있습니다. 한 논리적 업로드에는 같은 키를 보존합니다. 결과가 불명확하다는 이유로 다른 키를 만들지 않습니다.

## 성공과 결과 불명

upload는 파일의 불변 스냅샷·전체 크기·SHA-256을 먼저 확정하고, 최대 262,144바이트의 raw HTTP 청크를 보냅니다. 서버가 임시 보관 완료를 반환하고 같은 UUID의 ready 상태·전체 해시·수신 바이트 수까지 확인하면 stdout은 아래 JSON 한 줄뿐입니다.

```json
{"uuid":"12345678-1234-4234-8234-123456789abc"}
```

초기에 UUID를 받으면 stderr에도 해당 UUID와 staging 단계만 기록합니다. 성공 stdout을 보존해 기존 원격 MCP의 UUID 파일 처리에 전달합니다. status 출력의 원래 파일명·내부 경로·파일 바이트·owner 쿠키는 모델에게 전달되지 않습니다.

중간 응답이 끊기거나 청크 확인에 실패하면 성공 UUID를 stdout에 쓰지 않습니다. stderr에는 에러 코드·알고 있는 같은 UUID·단계와 확인 가능한 수신 상태만 남습니다. 클라이언트는 새 업로드를 만들거나 청크·complete 요청을 자동 반복하지 않습니다.

```powershell
node @portalFiles status '12345678-1234-4234-8234-123456789abc'
```

status는 같은 UUID의 state·size·sha256·expiresAt·received·sequence만 읽습니다. staging은 수신 중, ready는 서버 임시 보관 완료, expired는 만료입니다. 후속 파일 동작의 consuming·moved·removed도 상태로 관측할 수 있습니다. ready는 PC나 SSH 목적지에 저장됐다는 뜻이 아닙니다.

이미 일부를 받은 staging 업로드는 자동 재개하지 않습니다. ARTIFACT_ALREADY_STAGING이면 같은 UUID의 상태와 원본을 유지합니다. 시작 응답 자체가 유실되어 UUID를 모르면 원래 operation-key와 오류 기록을 유지하고 서버에서 해당 업로드를 확인해야 합니다. 다른 키로 새 요청을 만들어 결과를 추측하지 않습니다.

동일한 키가 이미 ready인 동일 크기·해시의 파일을 가리키면 그 UUID를 관측해 반환하며 파일 청크나 완료 요청을 다시 보내지 않습니다. 파일 바이트·크기·해시가 다르면 중지합니다.

## 배포 파일

ssh-approval-portal-client-2.0.0.tar.gz와 같은 이름의.zip은 동일 클라이언트 소스를 담습니다. client-manifest.json은 포함 파일의 크기·SHA-256과 Node 요구사항을 기록합니다. SHA256SUMS-client-2.0.0은 두 압축 파일의 전체 해시입니다. 서버 설치 파일이나 인증 캐시는 포함하지 않습니다.

개발자는 python scripts/package-client.py --output 새출력폴더로 같은 진입점의 소스 의존 그래프를 묶습니다. 기존 결과물은 덮어쓰지 않습니다. 로컬 생성 허용과 제품 동작 시험은 구분하며, 동작 회귀와 압축 해제 사본의 실행 검사는 승인된 TEST 환경에서 수행합니다.
