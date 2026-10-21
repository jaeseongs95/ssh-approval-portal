# Cloudflare 없는 HTTPS와 OIDC 로그인

개발 중인 `oidc` 관리자 인증은 Caddy의 공개 HTTPS 종료와 OAuth2 Proxy의 OIDC 로그인을 사용한다. 중계기는 전달된 ID 토큰의 서명·issuer·client ID·유효기간·검증된 이메일과 정확한 owner 목록을 별도로 확인한다. 기존 `token`·Cloudflare `access` 방식도 유지한다. 아직 실제 공개 CA 발급·공개 DNS·외부 SSO 로그인을 검증한 결과는 아니다.

로그인 공급자에 confidential OIDC client를 만들고 관리자 호스트의 `https://관리자호스트/oauth2/callback` 하나를 등록한다. ID 토큰에 `sub`, `iat`, `exp`, `email`, `email_verified=true`가 있어야 한다. client ID와 issuer는 중계기·프록시에서 정확히 일치시킨다. 프록시가 code/state/nonce/PKCE와 브라우저 세션을 처리하며 중계기는 클라이언트 비밀값이나 브라우저 쿠키를 보관하지 않는다. 공급자 로그인·동의를 실제로 확인하기 전에는 SSO 검증 완료로 기록하지 않는다.

관리자 터미널에서 기존 ENV의 다른 항목을 보존하며 다음 공개 설정을 추가한다. `JWKS_URL`은 공급자가 게시한 정확한 HTTPS 주소이며 토큰의 `jku`·`x5u`를 따라가지 않는다. 여러 audience가 있는 토큰은 이 client ID와 일치하는 `azp`도 필요하다. 지원 서명은 RS256·ES256이며 이메일이 검증되지 않았거나 owner 목록에 없으면 거부한다.

프록시·callback을 준비한 뒤 네이티브 설치에서는 기존 설정 연결 도구를 사용할 수 있다. 아래 명령은 issuer·JWKS·공개 client ID·정확한 owner 이메일만 입력받으며 client secret을 받지 않는다. `--dry-run`은 계획만 표시한다. 실제 실행은 기존 ENV를 백업하고 유지보수 예약·재시작·OIDC health와 비인증 401을 확인한다. 실패 시 설정이 이후 변경되지 않았을 때만 원래 ENV로 복구한다. SSH 관리자 콘솔을 유지한 상태에서 실행하고, 표시된 백업 경로를 보관한다. health 성공이 실제 공급자 로그인 성공을 보장하지는 않는다.

```bash
python3 scripts/portal.py connect oidc --dry-run
sudo python3 scripts/portal.py connect oidc
```

Google 로그인은 OAuth 클라이언트 유형을 웹 애플리케이션으로 등록하고, 승인된 리디렉션 URI에 실제 관리자 호스트의 `/oauth2/callback`을 정확히 등록한다. issuer는 `https://accounts.google.com`, JWKS는 Google discovery 문서의 `jwks_uri`를 사용한다. 공개 client ID는 Google에서 발급한 값을 사용하며 관리자 화면·프록시·중계기에 동일하게 맞춘다. client secret은 프록시 전용 비밀 파일에만 보관한다. 다른 사람의 계정도 허용하는 Google 동의 화면 설정과 별개로 이 포털은 정확한 owner 이메일 목록을 다시 검사한다. 실제 Google 계정 동의·callback·로그아웃 검증은 별도이며, 합성 Google 형식의 client ID 검사는 그 증거가 아니다.

네이티브 프록시의 설치 파일은 아래 도구로 먼저 준비할 수 있다. JSON에는 `name`, `adminHostname`, `mcpHostname`, `issuer`, `clientId`, `owners`를 지정하고 비밀값을 넣지 않는다. 포트는 선택 항목인 `adminPort`·`mcpPort`·`proxyPort`로 지정하며 기본값은 각각 39125·39124·4180이다. 기존 Cloudflare callback이 있다면 유지하고 별도 OIDC callback의 추가 범위를 확인한다.

```bash
python3 scripts/prepare-oidc-proxy.py --config /etc/ssh-portal-oidc-public.json --dry-run
sudo python3 scripts/prepare-oidc-proxy.py --config /etc/ssh-portal-oidc-public.json --prepare
```

실제 준비는 Linux root의 터미널에서 기존 client secret을 두 번 숨김 입력받고 `/var/lib/ssh-portal-oidc/<name>`을 새로 만든다. 숨김 입력을 사용할 수 없으면 일반 입력으로 전환하지 않고 중단한다. 공개 JSON도 root 소유의 쓰기 제한 경로에 둔다. 비밀 파일과 준비 파일은 0600, 전용 디렉터리는 0700이며 기존 경로는 덮어쓰지 않는다. 실패한 불완전 디렉터리는 조사용으로 남고 준비 완료로 표시하지 않는다. 이 단계는 서비스 설치·시작, ENV·DNS·OAuth 등록을 실행하지 않는다.

생성한 두 unit은 systemd `LoadCredential`과 `DynamicUser`를 사용한다. Caddy 인증서 상태는 별도 `StateDirectory`에 보존하고 Caddy 관리자 API·QUIC·로그는 켜지 않는다. 이후 설치에서는 검증된 Caddy 2.11.7·OAuth2 Proxy 7.15.5 바이너리의 전용 경로, 공개 80/443 경로, 정확한 DNS와 callback을 확인해야 한다. 준비 완료는 설치·인증서 발급·실제 로그인 성공을 뜻하지 않는다.

전용 서비스 설치 도구는 먼저 공개 설정에서 준비 파일을 다시 생성해 비교하고 비밀 파일의 권한·형식을 검사한다. 준비 완료 파일이 존재한다는 이유만으로 설치하지 않는다. 숨김 입력이나 저장장치 오류로 준비 명령이 실패했다면 보호된 파일과 종료 상태를 확인한 뒤 진행한다. 현재 자동 바이너리 검증은 Linux amd64용 Caddy 2.11.7·OAuth2 Proxy 7.15.5에 한정한다. ARM에서는 실행 전에 중단한다.

```bash
# 기본 실행은 계획만 표시한다.
python3 scripts/install-oidc-proxy.py --config /etc/ssh-portal-oidc-public.json
# root 소유·0755의 공식 실행 파일을 지정한다. 내용의 크기·SHA256도 별도로 검사한다.
sudo python3 scripts/install-oidc-proxy.py --config /etc/ssh-portal-oidc-public.json --install --caddy-binary /root/oidc-bin/caddy --proxy-binary /root/oidc-bin/oauth2-proxy
sudo python3 scripts/install-oidc-proxy.py --config /etc/ssh-portal-oidc-public.json --remove
```

설치는 새 전용 unit과 시작 링크만 만들며 기존 서비스·unit·링크는 덮어쓰지 않는다. 실제 시작은 공개 80/443을 사용할 수 있으므로 DNS·방화벽·Google callback과 기존 웹 서버의 충돌을 확인한 승인된 대상에서만 실행한다. 설치 상태가 `SERVICES_ACTIVE_LOGIN_UNVERIFIED`이면 프로세스 시작만 확인한 것이며 실제 공개 인증서와 Google 로그인을 별도로 검증해야 한다. 기존 중계기 ENV 연결은 앞의 `connect oidc` 단계에서 처리한다.

제거는 설치 기록에 있는 파일 식별자·실제 내용·서비스 경로·추가 설정을 검사한 뒤 자신의 서비스만 중지한다. ENV·준비 비밀·인증서 상태와 공유 버전 바이너리 캐시는 보존한다. 시작 실패의 정상 복구는 전용 unit을 정리하지만, 기록되지 않은 부분 파일·외부 변경·명령 시간초과 등으로 복구가 불확실하면 보호된 `installation.json`을 남기고 수동 확인을 요구한다. 실패한 설치 경로를 덮어써 반복 실행하지 않는다. 이 도구의 합성 서비스 검사나 unit parser 성공은 실제 systemd·공개 HTTPS·Google 로그인 검증을 대신하지 않는다.

설정 도구는 Node와 systemd가 같은 값을 읽을 수 있게 OIDC 값을 인용한다. 단일 따옴표와 이중 따옴표·역슬래시가 함께 들어 있어 두 형식으로 안전하게 표현할 수 없는 값은 저장 전에 거부한다. 전체 ENV가 64KiB를 넘는 경우도 이후 설정·복구가 막히지 않도록 파일 교체 전에 거부한다. 기존 비밀값의 인용 방식은 바꾸지 않는다.

```dotenv
BRIDGE_ADMIN_AUTH_MODE=oidc
BRIDGE_ADMIN_ORIGIN=https://approve.example.com
BRIDGE_OIDC_ISSUER=https://idp.example.com/realms/portal
BRIDGE_OIDC_JWKS_URL=https://idp.example.com/realms/portal/protocol/openid-connect/certs
BRIDGE_OIDC_CLIENT_ID=portal-client
BRIDGE_OIDC_OWNER_EMAILS=owner@example.com
```

[Caddy 예제](../deploy/oidc/Caddyfile)에서 두 DNS 호스트를 지정하고 [OAuth2 Proxy 예제](../deploy/oidc/oauth2-proxy.cfg)의 공개 issuer·client ID·callback을 바꾼다. 정확한 owner 이메일을 `/etc/ssh-portal-oidc/owners`에 한 줄씩 기록한다. 프록시 client secret과 32바이트 cookie secret은 예제의 파일 경로에 별도 보관한다. 비밀 파일은 프록시 서비스 계정만 읽게 하고, 토큰·키·비밀 파일 내용을 채팅·명령행 인자·로그에 넣지 않는다. 실제 파일·서비스 설치 전에는 대상과 복구 조건을 확인해야 한다.

설정 예제는 공식 Caddy 2.11.7과 OAuth2 Proxy 7.15.5 바이너리로 네트워크를 차단한 환경에서 파싱했다. 이 검사는 서비스를 공개하거나 인증서를 발급하지 않는다. 중계기의 기본 포트를 바꿨다면 예제의 loopback upstream 포트도 실제 값과 맞춘다.

Caddy는 관리자 요청을 loopback OAuth2 Proxy로 전달하고 프록시가 검증된 ID 토큰을 `Authorization`으로 중계기에 전달한다. 중계기 관리자 포트와 OAuth2 Proxy 포트를 외부에 직접 노출하지 않는다. MCP 호스트는 기존 MCP 포트에 별도로 전달하며 MCP 토큰은 계속 필요하다. 관리자 SSO 토큰과 유지보수용 관리자 토큰은 서로 대신할 수 없다. 승인 POST의 정확한 Origin 검사와 파일 다운로드의 로그인·일회성 자격 검사는 유지된다.

화면은 SSO로 자동 연결하고 관리자 토큰 입력을 숨긴다. 로그아웃은 프록시의 `/oauth2/sign_out`으로 이동한다. 공급자 자체의 로그인 세션 종료와 이미 발급된 ID 토큰의 만료는 별개이므로 공급자의 전체 로그아웃 동작은 실제 통합에서 확인한다. 명령·sudo·파일·모델 자동승인 정책은 이 인증 설정만으로 켜지지 않는다.

공개 CA 발급에는 실제 DNS와 Caddy가 처리할 외부 TLS 경로가 필요하다. 현재 서버의 기존 터널·포트·인증서를 이 예제만으로 교체하지 않는다. 합성 서명·로컬 HTTPS 검사와 실제 공개 인증서·실제 계정 SSO를 구분한다.

계약 근거: [OIDC ID 토큰 검증](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation), [OAuth2 Proxy 설정](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/), [Caddy HTTPS](https://caddyserver.com/docs/automatic-https/).

Google 계약: [OpenID Connect와 클라이언트 등록](https://developers.google.com/identity/openid-connect/openid-connect), [발견 문서](https://accounts.google.com/.well-known/openid-configuration).
