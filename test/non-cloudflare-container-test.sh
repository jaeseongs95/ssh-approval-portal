#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && ${container:-} == docker ]] || { echo 'Isolated root Docker fixture only' >&2; exit 1; }
cd /source
python3 scripts/portal.py install --admin-origin https://approve.fixture.test:4443 --grant-sudo-all
systemctl stop ssh-approval-bridge.service
python3 test/delivery-fixture.py docker-settings /etc/ssh-mcp-approval-bridge.env
printf '\nBRIDGE_UI_ENABLED=true\n' >> /etc/ssh-mcp-approval-bridge.env
systemctl restart ssh-approval-bridge.service
for attempt in {1..100}; do
  if curl -fsS http://127.0.0.1:39224/health >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS http://127.0.0.1:39224/health >/dev/null
install -d -m 0700 /root/non-cloudflare-tls
cd /root/non-cloudflare-tls
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -subj /CN=IsolatedLocalFixtureCA -days 1 >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=approve.fixture.test >/dev/null 2>&1
printf 'subjectAltName=DNS:approve.fixture.test,DNS:mcp.fixture.test\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 1 -extfile server.ext >/dev/null 2>&1
active=$(readlink -f /var/lib/ssh-mcp/app/approval-bridge)
cd "$active"
node test/non-cloudflare-https.mjs
python3 /source/scripts/portal.py verify
echo 'LOCAL NON-CLOUDFLARE HTTPS/TOKEN/OWNER APPROVAL/SSH/FILE CAPABILITIES: PASS'
