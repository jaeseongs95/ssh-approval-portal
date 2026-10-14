#!/usr/bin/env bash
set -euo pipefail
wait_healthy() {
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:39124/health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
cd /source
bash scripts/install.sh --admin-origin https://example.test --grant-sudo-all
node scripts/verify.mjs .
active=$(readlink -f /var/lib/ssh-mcp/app/approval-bridge)
env_before=$(sha256sum /etc/ssh-mcp-approval-bridge.env | cut -d' ' -f1)
key_before=$(sha256sum /var/lib/ssh-mcp/.ssh/id_ed25519 | cut -d' ' -f1)
grant_before=$(sha256sum /etc/sudoers.d/90-mcpops-approval-bridge | cut -d' ' -f1)
bash scripts/install.sh
[[ $(readlink -f /var/lib/ssh-mcp/app/approval-bridge) == "$active" ]]
[[ $(sha256sum /etc/ssh-mcp-approval-bridge.env | cut -d' ' -f1) == "$env_before" ]]
[[ $(sha256sum /var/lib/ssh-mcp/.ssh/id_ed25519 | cut -d' ' -f1) == "$key_before" ]]
[[ $(sha256sum /etc/sudoers.d/90-mcpops-approval-bridge | cut -d' ' -f1) == "$grant_before" ]]
systemctl is-enabled --quiet ssh-approval-bridge.service
test "$(systemctl show ssh-mcp.service -p LoadState --value)" = not-found
cd "$active"
node --test test/*.test.mjs
python3 test/test_helper.py
sed -i 's/^BRIDGE_UI_ENABLED=false$/BRIDGE_UI_ENABLED=true/' /etc/ssh-mcp-approval-bridge.env
systemctl restart ssh-approval-bridge.service
wait_healthy
node test/ssh-roundtrip.mjs
backup=$(find /var/lib/ssh-mcp/app/backups -mindepth 1 -maxdepth 1 -type d | sort | tail -n1)
bash /source/scripts/rollback.sh "$backup"
systemctl is-active --quiet ssh-approval-bridge.service
# A syntactically valid but unbootable candidate must restore the healthy release.
cp -a /source /root/failing-release
printf '\nthrow Error("synthetic startup failure");\n' >> /root/failing-release/bridge.mjs
python3 - <<'PY'
import json, hashlib, pathlib
root = pathlib.Path('/root/failing-release')
manifest = root / 'release-manifest.json'
data = json.loads(manifest.read_text())
for item in data['files']:
    raw = (root / item['path']).read_bytes()
    item.update(size=len(raw), sha256=hashlib.sha256(raw).hexdigest())
manifest.write_text(json.dumps(data) + '\n')
PY
if bash /root/failing-release/scripts/install.sh; then
  echo 'Broken candidate unexpectedly installed' >&2; exit 1
fi
[[ $(readlink -f /var/lib/ssh-mcp/app/approval-bridge) == "$active" ]]
[[ $(sha256sum /etc/ssh-mcp-approval-bridge.env | cut -d' ' -f1) == "$env_before" ]]
[[ $(sha256sum /etc/sudoers.d/90-mcpops-approval-bridge | cut -d' ' -f1) == "$grant_before" ]]
systemctl is-active --quiet ssh-approval-bridge.service
curl -fsS http://127.0.0.1:39124/health >/dev/null
systemctl restart ssh-approval-bridge.service
wait_healthy
curl -fsS http://127.0.0.1:39124/health >/dev/null
echo 'INSTALL, REINSTALL, SECRET/KEY/SUDO PRESERVATION, SSH BYTE ROUNDTRIP, ROLLBACK, FAILED-START RECOVERY, RESTART: PASS'
