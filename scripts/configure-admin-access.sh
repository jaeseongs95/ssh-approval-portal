#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run from the administrator terminal with sudo.' >&2; exit 1; }
config_args=()
health_args=(access)
if [[ $# == 1 && ( $1 == --restore-owned-access || $1 == --restore-owned-oidc ) ]]; then
  config_args=("$1")
  health_args=()
elif [[ $# == 1 && ( $1 == --link-owned-access || $1 == --link-owned-oidc || $1 == --oidc ) ]]; then
  config_args=("$1")
  if [[ $1 == *oidc ]]; then health_args=(oidc); fi
elif [[ $# != 0 ]]; then
  echo 'Unknown Access configuration mode.' >&2
  exit 1
fi
active=/var/lib/ssh-mcp/app/approval-bridge
node=/opt/ssh-approval/node/bin/node
. "$active/scripts/maintenance-owner.sh"
env_file=/etc/ssh-mcp-approval-bridge.env
[[ -f "$env_file" && ! -L "$env_file" ]] || { echo 'Expected a native managed secret file.' >&2; exit 1; }
"$node" "$active/scripts/verify.mjs" "$active"
exec 9>/var/lib/ssh-mcp/.portal-install.lock
flock -n 9
before=$(sha256sum "$env_file" | cut -d' ' -f1)
work=$(mktemp -d /run/ssh-admin-access.XXXXXXXX)
reserved=0
captured=0
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
  recovery_ok=1
  if [[ $rc != 0 && $changed == 1 ]]; then
    recovery_ok=0
    if ! cmp -s -- "$env_file" "$work/proposed.env"; then
      echo "Configuration changed during setup. Automatic restore skipped. Recovery backup: $backup" >&2
    else
      restore_stage=$(mktemp /etc/.ssh-admin-access-restore.XXXXXXXX)
      if cp -a -- "$backup" "$restore_stage" && sync -f "$restore_stage" && mv -f -- "$restore_stage" "$env_file" && systemctl reset-failed ssh-approval-bridge.service && systemctl restart ssh-approval-bridge.service && wait_restored; then
        recovery_ok=1
        echo "Configuration restored from $backup" >&2
      else echo "Restore failed. Administrator recovery needed: $backup" >&2; fi
    fi
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
"$node" "$active/scripts/admin-access-config.mjs" "$env_file" "$work/proposed.env" "${config_args[@]}"
[[ -f "$work/proposed.env" && ! -L "$work/proposed.env" ]] || { echo 'Configuration staging did not complete.' >&2; exit 1; }
[[ $(sha256sum "$env_file" | cut -d' ' -f1) == "$before" ]] || { echo 'Configuration changed during setup; start again.' >&2; exit 1; }
maintenance_new_owner
"$node" "$active/scripts/maintenance.mjs" reserve < "$maintenance_owner_file"
reserved=1
"$node" "$active/scripts/maintenance.mjs" capture < "$maintenance_owner_file" || { echo 'Preservation capture unconfirmed; maintenance retained.' >&2; exit 1; }
captured=1
[[ $(sha256sum "$env_file" | cut -d' ' -f1) == "$before" ]] || { echo 'Configuration changed during maintenance reservation; no settings were replaced.' >&2; exit 1; }
backup=/etc/ssh-mcp-approval-bridge.env.before-access.$(date -u +%Y%m%dT%H%M%SZ).$$
cp -a -- "$env_file" "$backup"
sync -f "$backup"
[[ $(sha256sum "$backup" | cut -d' ' -f1) == "$before" ]] || { echo 'Configuration changed while creating the backup; no settings were replaced.' >&2; exit 1; }
stage=$(mktemp /etc/.ssh-admin-access.XXXXXXXX)
cp -- "$work/proposed.env" "$stage"
chown --reference="$env_file" "$stage"
chmod 0600 "$stage"
sync -f "$stage"
[[ $(sha256sum "$env_file" | cut -d' ' -f1) == "$before" ]] || { echo 'Configuration changed before replacement; no settings were replaced.' >&2; exit 1; }
mv -f -- "$stage" "$env_file"
changed=1
systemctl reset-failed ssh-approval-bridge.service
systemctl restart ssh-approval-bridge.service
for attempt in {1..20}; do
  if "$node" "$active/scripts/healthcheck.mjs" "$env_file" "${health_args[@]}" 2>/dev/null; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$admin_port/api/requests")
    [[ "$code" == 401 ]] || { echo 'Unauthenticated administrator request was not rejected.' >&2; exit 1; }
    if [[ ${config_args[0]:-} != --restore-owned-access && ${config_args[0]:-} != --restore-owned-oidc ]]; then
      code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$admin_port/api/session")
      [[ "$code" == 401 ]] || { echo 'Unauthenticated owner session was not rejected.' >&2; exit 1; }
      if [[ ${config_args[0]:-} == *oidc ]]; then
        echo "Owner OIDC mode enabled. Backup: $backup"
        echo 'Verify the configured OIDC proxy and owner login in the browser. No client secret was requested.'
      else
        echo "Owner Access mode enabled. Backup: $backup"
        echo 'Test Cloudflare, Google and GitHub login in the browser; no administrator token entry is required.'
      fi
    else
      echo "Previous owner authentication restored. Backup: $backup"
    fi
    exit 0
  fi
  sleep 1
done
echo 'Access health check failed; restoring configuration.' >&2
exit 1
