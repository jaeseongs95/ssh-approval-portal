#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run from the administrator terminal with sudo.' >&2; exit 1; }
active=/var/lib/ssh-mcp/app/approval-bridge
node=/opt/ssh-approval/node/bin/node
. "$active/scripts/maintenance-owner.sh"
env_file=/etc/ssh-mcp-approval-bridge.env
[[ -f "$env_file" && ! -L "$env_file" ]] || { echo 'Expected the native managed secret file.' >&2; exit 1; }
"$node" "$active/scripts/verify.mjs" "$active"
exec 9>/var/lib/ssh-mcp/.portal-install.lock
flock -n 9
before=$(sha256sum "$env_file" | cut -d' ' -f1)
work=$(mktemp -d /run/ssh-upload-sources.XXXXXXXX)
reserved=0
captured=0
changed=0
backup=
stage=
restore_stage=
healthy() { "$node" "$active/scripts/healthcheck.mjs" "$env_file" 2>/dev/null; }
wait_healthy() { for attempt in {1..20}; do if healthy; then return 0; fi; sleep 1; done; return 1; }
cleanup() {
  rc=$?
  trap - EXIT
  set +e
  recovery_ok=1
  if [[ $rc != 0 && $changed == 1 ]]; then
    recovery_ok=0
    restore_stage=$(mktemp /etc/.ssh-upload-sources-restore.XXXXXXXX)
    if cp -a -- "$backup" "$restore_stage" && sync -f "$restore_stage" && mv -f -- "$restore_stage" "$env_file" && systemctl reset-failed ssh-approval-bridge.service && systemctl restart ssh-approval-bridge.service && wait_healthy; then
      recovery_ok=1
      echo "Configuration restored from $backup" >&2
    else echo "Restore failed. Administrator recovery needed: $backup" >&2; fi
  fi
  if [[ $reserved == 1 && $recovery_ok == 1 && $captured == 1 ]]; then
    "$node" "$active/scripts/maintenance.mjs" compare < "$maintenance_owner_file" || { recovery_ok=0; rc=1; }
  fi
  if [[ $reserved == 1 && $recovery_ok == 1 && $captured == 1 ]]; then
    if "$node" "$active/scripts/maintenance.mjs" release < "$maintenance_owner_file"; then maintenance_forget_owner; else rc=1; fi
  fi
  if [[ $reserved == 1 && ( $recovery_ok != 1 || $captured != 1 ) ]]; then echo 'Maintenance retained: preservation or recovery not confirmed.' >&2; fi
  rm -f -- "$work/proposed.env"
  if [[ -n "$stage" ]]; then rm -f -- "$stage"; fi
  if [[ -n "$restore_stage" ]]; then rm -f -- "$restore_stage"; fi
  rmdir -- "$work"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
python3 "$active/scripts/configure-upload-sources.py" "$env_file" "$work/proposed.env"
[[ $(sha256sum "$env_file" | cut -d' ' -f1) == "$before" ]] || { echo 'Configuration changed during setup; start again.' >&2; exit 1; }
maintenance_new_owner
"$node" "$active/scripts/maintenance.mjs" reserve < "$maintenance_owner_file"
reserved=1
"$node" "$active/scripts/maintenance.mjs" capture < "$maintenance_owner_file" || { echo 'Preservation capture unconfirmed; maintenance retained.' >&2; exit 1; }
captured=1
backup=/etc/ssh-mcp-approval-bridge.env.before-upload-sources.$(date -u +%Y%m%dT%H%M%SZ).$$
cp -a -- "$env_file" "$backup"
sync -f "$backup"
stage=$(mktemp /etc/.ssh-upload-sources.XXXXXXXX)
cp -- "$work/proposed.env" "$stage"
chown --reference="$env_file" "$stage"
chmod 0600 "$stage"
sync -f "$stage"
mv -f -- "$stage" "$env_file"
changed=1
systemctl reset-failed ssh-approval-bridge.service
systemctl restart ssh-approval-bridge.service
wait_healthy || { echo 'File source setup health check failed; restoring.' >&2; exit 1; }
echo "File source allowlist updated. Backup: $backup"
echo 'Use a platform file input, then approve its exact hash and destination in the card or website.'
