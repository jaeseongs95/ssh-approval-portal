#!/usr/bin/env bash
set -euo pipefail
wait_healthy() {
  local mcp_port
  mcp_port=$(python3 /source/scripts/settings_contract.py port /etc/ssh-mcp-approval-bridge.env mcp)
  for attempt in {1..30}; do
    if curl -fsS "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
latest_backup() { find /var/lib/ssh-mcp/app/backups -mindepth 1 -maxdepth 1 -type d | sort | tail -n1; }
cd /source
if [[ ${TEST_HAS_BASELINE:-0} == 1 ]]; then
  bash /baseline/scripts/install.sh --admin-origin https://example.test --grant-sudo-all
  systemctl stop ssh-approval-bridge.service
  python3 test/delivery-fixture.py docker-settings /etc/ssh-mcp-approval-bridge.env
  sed -i '/^\[Service\]/a Environment=BRIDGE_DELIVERY_FIXTURE=preserved' /etc/systemd/system/ssh-approval-bridge.service
  systemctl daemon-reload; systemctl restart ssh-approval-bridge.service
  wait_healthy
  baseline_active=$(readlink -f /var/lib/ssh-mcp/app/approval-bridge)
  python3 test/delivery-fixture.py capture /root/baseline-state.json
  python3 /source/scripts/portal.py update
  python3 test/delivery-fixture.py assert-preserved /root/baseline-state.json
  upgrade_backup=$(latest_backup)
else
  python3 /source/scripts/portal.py install --admin-origin https://example.test --grant-sudo-all
  systemctl stop ssh-approval-bridge.service
  python3 test/delivery-fixture.py docker-settings /etc/ssh-mcp-approval-bridge.env
  systemctl restart ssh-approval-bridge.service
  wait_healthy
fi
python3 -I -B test/test_portal_setup.py
python3 scripts/portal.py connect env-editor
systemctl is-active --quiet ssh-approval-env.socket
python3 -I -B test/test_env_editor_lock.py
node scripts/verify.mjs .
active=$(readlink -f /var/lib/ssh-mcp/app/approval-bridge)
python3 test/delivery-fixture.py capture /root/candidate-state.json
env_before=$(sha256sum /etc/ssh-mcp-approval-bridge.env | cut -d' ' -f1)
python3 /source/scripts/portal.py update
[[ $(readlink -f /var/lib/ssh-mcp/app/approval-bridge) == "$active" ]]
[[ $(sha256sum /etc/ssh-mcp-approval-bridge.env | cut -d' ' -f1) == "$env_before" ]]
python3 test/delivery-fixture.py assert-preserved /root/candidate-state.json
reinstall_backup=$(latest_backup)
systemctl is-enabled --quiet ssh-approval-bridge.service
test "$(systemctl show ssh-mcp.service -p LoadState --value)" = not-found
cd "$active"
node scripts/check-package-imports.mjs
if [[ $(uname -m) == aarch64 ]]; then
  echo 'Node suite runner: --test-concurrency=1 (ARM fixture; assertions unchanged, no retries)'
  node --test --test-concurrency=1 test/*.test.mjs
else
  node --test test/*.test.mjs
fi
python3 test/test_helper.py
python3 test/test_upload_sources.py
python3 test/test_settings_contract.py
python3 test/test_compose_env.py
python3 test/test_package.py
sed -i 's/^BRIDGE_UI_ENABLED=false$/BRIDGE_UI_ENABLED=true/' /etc/ssh-mcp-approval-bridge.env
systemctl restart ssh-approval-bridge.service
wait_healthy
node test/ssh-roundtrip.mjs
if [[ ${TEST_HAS_BASELINE:-0} == 1 ]]; then
  python3 /source/scripts/portal.py rollback "$upgrade_backup"
  [[ $(readlink -f /var/lib/ssh-mcp/app/approval-bridge) == "$baseline_active" ]]
  python3 /source/test/delivery-fixture.py assert-preserved /root/baseline-state.json
  python3 /source/scripts/portal.py update
else
  python3 /source/scripts/portal.py rollback "$reinstall_backup"
fi
python3 /source/test/delivery-fixture.py assert-preserved /root/candidate-state.json
# The fixture produces a valid manifest whose bridge fails during actual startup.
cp -a /source /root/failing-release
python3 /source/test/delivery-fixture.py break-release /root/failing-release
if python3 /root/failing-release/scripts/portal.py update; then
  echo 'Broken candidate unexpectedly installed' >&2; exit 1
fi
[[ $(readlink -f /var/lib/ssh-mcp/app/approval-bridge) == "$active" ]]
[[ $(sha256sum /etc/ssh-mcp-approval-bridge.env | cut -d' ' -f1) == "$env_before" ]]
python3 /source/test/delivery-fixture.py assert-preserved /root/candidate-state.json
systemctl is-active --quiet ssh-approval-bridge.service
wait_healthy
systemctl restart ssh-approval-bridge.service
wait_healthy
node /source/test/delivery-runtime.mjs
echo "UNIFIED CLI INSTALL, CUSTOM PORTS, REINSTALL, SETTINGS/KEY/SUDO/UNIT/AUDIT PRESERVATION, SSH ROUNDTRIP, ROLLBACK, FAILED-START RECOVERY: PASS; baseline=${TEST_HAS_BASELINE:-0}"
