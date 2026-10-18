# Cloudflare 없이 연결하기

서버의 기본 관리자 인증은 `token`입니다. Cloudflare Access·Tunnel 없이도 HTTPS 역방향 프록시를 통해 MCP와 관리자 화면을 연결할 수 있습니다. 이 경로에서도 명령과 파일은 기존 소유자 승인 정책을 따릅니다.

서버의 관리자 터미널에서 실제 관리자 HTTPS origin으로 설치합니다.

```bash
python3 scripts/portal.py install --admin-origin https://approve.example.com --dry-run
sudo python3 scripts/portal.py install --admin-origin https://approve.example.com
```

HTTPS 종료와 인증서는 운영 환경에서 준비합니다. MCP 호스트는 loopback MCP 포트(기본 39124), 관리자 호스트는 loopback 관리자 포트(기본 39125)로 전달합니다. 역방향 프록시는 `Authorization`과 `Origin`을 보존하며 관리자 origin은 `BRIDGE_ADMIN_ORIGIN`과 정확히 일치해야 합니다. 인증서의 신뢰 체인과 호스트명을 검증하는 클라이언트를 사용합니다.

MCP 클라이언트에는 MCP 토큰을 연결 설정으로 등록하고, 관리자 화면에는 별도의 관리자 토큰을 입력합니다. 토큰은 서버의 시크릿 설정에서 관리하며 URL이나 명령행 인자로 전달하지 않습니다. `BRIDGE_ADMIN_AUTH_MODE=token`에서는 Cloudflare 로그인 헤더가 관리자 토큰을 대신하지 않습니다. SSO가 필요하면 별도의 인증 공급자 통합이 필요합니다.

정책은 관리자 화면에서 저장합니다. 명령 등록·sudo·업로드·다운로드·모델 자동승인은 기존의 독립 설정이며 HTTPS 연결 성공만으로 활성화되지 않습니다. 다운로드 링크도 요청의 승인과 일회성 자격을 그대로 적용합니다.

로컬 재현은 `test/non-cloudflare-container-test.sh`를 격리 Linux 컨테이너에서 실행합니다. 합성 CA와 두 호스트의 인증서를 만들어 실제 TLS 검증을 수행하고, 관리자/MCP 토큰 구분·위조 헤더·잘못된 Origin·수동 승인·실제 SSH와 바이너리 파일 왕복·일회성 링크·프록시 장애를 검사합니다. 이 CA를 실제 서버나 사용자 기기에 설치하지 않습니다.

로컬 CA 검사는 공개 인증서 발급·공개 DNS·외부 프록시 제품·실제 SSO 로그인을 완료했다는 뜻이 아닙니다. 실행 결과는 별도 로컬 검증 기록에서 확인합니다.
