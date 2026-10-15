# 관리자 로그인

기본값은 기존 관리자 토큰 방식입니다. `access` 모드는 Cloudflare Access가 발급한 사람의 로그인 JWT를 서버에서 확인하며, 관리자 토큰으로 웹 승인 API를 호출하는 경로는 닫습니다. 로컬 설치·업데이트의 유지보수 API만 서버에 보관된 토큰을 계속 사용합니다. SSH 명령 권한과 MCP 연결 방식은 바꾸지 않습니다.

## Cloudflare·Google·GitHub 로그인 준비

1. Cloudflare Zero Trust → Integrations → Identity providers에서 Cloudflare, Google, GitHub를 등록합니다. 기존 팀이라 Cloudflare가 없다면 Add new identity provider에서 Cloudflare를 추가하고 계정 구성원 제한을 켭니다.
2. Google Cloud Console에서 웹 OAuth 클라이언트를 만듭니다. 허용 JavaScript 출처는 `https://YOUR_TEAM.cloudflareaccess.com`, 리디렉션 URI는 `https://YOUR_TEAM.cloudflareaccess.com/cdn-cgi/access/callback`입니다. 생성한 Client ID·Secret은 Cloudflare의 Google 제공자 설정에 직접 입력하고 Test를 완료합니다.
3. GitHub Settings → Developer settings → OAuth Apps에서 앱을 만듭니다. Homepage는 같은 팀 도메인, Authorization callback URL은 위 callback입니다. Client ID·Secret은 Cloudflare의 GitHub 제공자 설정에 입력하고 Finish setup → Authorize → Test를 완료합니다.
4. Access controls → Applications의 `ssh-approve` 앱에서 세 로그인 방법을 선택합니다. 제공자 선택 화면을 유지하려면 단일 제공자로 자동 리디렉션하지 않습니다. Allow 정책에는 본인의 정확한 이메일만 넣으며 `Everyone`이나 우회 정책을 사용하지 않습니다. 세 제공자가 서로 다른 이메일을 반환하면 허용할 본인 주소를 각각 명시합니다.
5. 앱의 Application Audience(AUD)를 복사합니다. 팀 도메인, AUD, 허용 이메일은 서버 설정에도 필요합니다. Google/GitHub의 Secret은 서버·대화·저장소에 전달하지 않습니다. 현재 관리자가 로그인한 세션을 유지한 채 별도 브라우저 창에서 세 방법을 시험합니다.

절차 출처: [Cloudflare](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/), [Google](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/), [GitHub](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/), [JWT 검증](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## 서버 적용

먼저 이 코드가 포함된 검증된 패키지를 설치합니다. Cloudflare/provider 설정과 실제 로그인을 확인한 뒤 본인 관리자 터미널에서 실행합니다. 실행 중 새 요청·승인을 멈춰 주세요.

```bash
sudo bash /var/lib/ssh-mcp/app/approval-bridge/scripts/configure-admin-access.sh
```

팀 HTTPS 도메인, AUD, 본인 이메일을 서버 터미널에서 입력합니다. 스크립트는 현재 설치 manifest와 설정 해시를 확인하고 요청이 없는 상태에서 유지보수를 예약합니다. 기존 토큰·UI 활성화·SSH 설정은 보존하며, 설정 백업 후 원자적으로 교체하고 서비스를 재시작합니다. 시작 검사가 실패하면 기존 설정으로 복구합니다. 비밀값은 출력하지 않습니다. 세 공급자의 실제 브라우저 로그인이 실패해도 건강 상태 검사는 통과할 수 있으므로 아래 시험을 별도로 해야 합니다.

Docker에서는 `/etc/ssh-approval-portal/docker-secrets.env`에 같은 네 설정을 추가합니다. 업데이트 전에 모든 요청·전송을 마치고 컨테이너를 안전하게 중지합니다. 기존 시크릿·소유권·`0600`을 유지하고, Compose를 다시 생성합니다. native용 위 스크립트로 Docker 서비스를 재시작하지 않습니다.

```dotenv
BRIDGE_ADMIN_AUTH_MODE=access
BRIDGE_ACCESS_TEAM_DOMAIN=https://YOUR_TEAM.cloudflareaccess.com
BRIDGE_ACCESS_AUD=YOUR_APPLICATION_AUD_64_HEX
BRIDGE_ACCESS_OWNER_EMAILS=owner@example.com
```

Cloudflare Tunnel은 현재 loopback `39125` 경로와 Access 보호를 유지합니다. 서버는 고정된 팀 JWKS·issuer·앱 audience·RS256 서명·시간·사람의 `sub/email/type`·정확한 이메일을 검증합니다. 서명되지 않은 이메일 헤더는 인정하지 않습니다. 브라우저는 JWT나 관리자 토큰을 별도 저장하지 않습니다. Access 모드 파일 다운로드 링크도 로그인한 소유자에게만 허용하므로 호스트 저장 API가 세션을 전달하지 못하면 브라우저 저장으로 전환합니다. 실제 클라이언트 저장은 별도 시험 대상입니다.

## 실제 수용 시험과 복구

- 화면 오른쪽 위의 **로그아웃**은 자동 조회를 멈추고 표시 중인 요청을 비운 뒤 [Cloudflare Access의 로그아웃 경로](https://developers.cloudflare.com/cloudflare-one/faq/authentication-faq/#how-do-end-users-log-out-of-an-application-protected-by-access)로 이동합니다. 토큰 방식에서는 이 탭의 입력 토큰만 지우고 초기 화면으로 돌아갑니다. 서버 토큰을 폐기하거나 이미 실행 중인 작업을 취소하지는 않습니다.
- Cloudflare·Google·GitHub 각각 새 브라우저 세션에서 로그인해 대기 목록·이력·카드 실행 결과가 보이는지 확인합니다. 관리자 토큰 입력란이 없어야 합니다.
- 허용하지 않은 계정, 로그인 없는 요청, 잘못된 앱의 JWT는 거부되어야 합니다. 승인·거부 POST는 같은 출처만 허용합니다.
- 승인·거부 후 즉시 조회하고 자동 조회는 10초입니다. 브라우저 언어가 `ko`이면 한국어, 그 외에는 영어입니다.
- 잠김 문제가 있으면 관리자 터미널에서 출력된 `.before-access.*` 백업 파일을 `/etc/ssh-mcp-approval-bridge.env`로 복원하고 서비스를 재시작합니다. 실행 중인 승인/전송이 있다면 먼저 마쳐야 하며, 메모리 큐는 재시작 후 복원되지 않습니다. Docker는 이전 시크릿 파일로 복원 후 재생성합니다.

합성 JWT 검사를 실제 제공자 로그인 성공으로 해석하지 않습니다. 실제 로그인·승인·파일 저장을 완료하기 전까지 배포 완료로 판정하지 않습니다.
