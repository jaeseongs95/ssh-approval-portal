#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run from the administrator terminal with sudo.' >&2; exit 1; }
active=/var/lib/ssh-mcp/app/approval-bridge
node=/opt/ssh-approval/node/bin/node
env_file=/etc/ssh-mcp-approval-bridge.env
[[ -f "$env_file" && ! -L "$env_file" ]] || { echo 'Expected a native managed secret file.' >&2; exit 1; }
"$node" "$active/scripts/verify.mjs" "$active"
exec 9>/var/lib/ssh-mcp/.portal-install.lock
flock -n 9
before=$(sha256sum "$env_file" | cut -d' ' -f1)
work=$(mktemp -d /run/ssh-admin-access.XXXXXXXX)
reserved=0
changed=0
backup=
stage=
restore_stage=
admin_port=$(python3 "$active/scripts/settings_contract.py" port "$env_file" admin)
wait_restored() {
  for attempt in {1..20}; do
    if "$node" "$active/scripts/healthcheck.mjs" "$env_file" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
cleanup() {
  rc=$?
  trap - EXIT
  set +e
  if [[ $rc != 0 && $changed == 1 ]]; then
    restore_stage=$(mktemp /etc/.ssh-admin-access-restore.XXXXXXXX)
    if cp -a -- "$backup" "$restore_stage" && sync -f "$restore_stage" && mv -f -- "$restore_stage" "$env_file" && systemctl reset-failed ssh-approval-bridge.service && systemctl restart ssh-approval-bridge.service && wait_restored; then
      echo "Configuration restored from $backup" >&2
    else echo "Restore failed. Administrator recovery needed: $backup" >&2; fi
  fi
  if [[ $reserved == 1 ]]; then "$node" "$active/scripts/maintenance.mjs" release || true; fi
  rm -f -- "$work/proposed.env"
  if [[ -n "$stage" ]]; then rm -f -- "$stage"; fi
  if [[ -n "$restore_stage" ]]; then rm -f -- "$restore_stage"; fi
  rmdir -- "$work"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
"$node" "$active/scripts/admin-access-config.mjs" "$env_file" "$work/proposed.env"
[[ -f "$work/proposed.env" && ! -L "$work/proposed.env" ]] || { echo 'Configuration staging did not complete.' >&2; exit 1; }
[[ $(sha256sum "$env_file" | cut -d' ' -f1) == "$before" ]] || { echo 'Configuration changed during setup; start again.' >&2; exit 1; }
"$node" "$active/scripts/maintenance.mjs" reserve
reserved=1
backup=/etc/ssh-mcp-approval-bridge.env.before-access.$(date -u +%Y%m%dT%H%M%SZ).$$
cp -a -- "$env_file" "$backup"
sync -f "$backup"
stage=$(mktemp /etc/.ssh-admin-access.XXXXXXXX)
cp -- "$work/proposed.env" "$stage"
chown --reference="$env_file" "$stage"
chmod 0600 "$stage"
sync -f "$stage"
mv -f -- "$stage" "$env_file"
changed=1
systemctl reset-failed ssh-approval-bridge.service
systemctl restart ssh-approval-bridge.service
for attempt in {1..20}; do
  if "$node" "$active/scripts/healthcheck.mjs" "$env_file" access 2>/dev/null; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$admin_port/api/session")
    [[ "$code" == 401 ]] || { echo 'Unauthenticated administrator request was not rejected.' >&2; exit 1; }
    echo "Owner Access mode enabled. Backup: $backup"
    echo 'Test Cloudflare, Google and GitHub login in the browser; no administrator token entry is required.'
    exit 0
  fi
  sleep 1
done
echo 'Access health check failed; restoring configuration.' >&2
exit 1
