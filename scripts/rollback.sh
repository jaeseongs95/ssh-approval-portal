#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $# == 1 ]] || { echo 'Usage: sudo bash scripts/rollback.sh /var/lib/ssh-mcp/app/backups/NAME' >&2; exit 1; }
app=/var/lib/ssh-mcp/app
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$source_dir/scripts/maintenance-owner.sh"
backup=$(realpath -- "$1")
[[ "$backup" == "$app"/backups/* && "$backup" != "$app/backups" && -f "$backup/previous-active" && ! -L "$backup" ]] || { echo 'Invalid backup' >&2; exit 1; }
previous=$(cat "$backup/previous-active")
[[ "$previous" == "$app"/releases/* || "$previous" == "$app"/approval-bridge.legacy.* ]] || { echo 'No previous release to restore' >&2; exit 1; }
[[ -d "$previous" && ! -L "$previous" ]] || { echo 'Previous release missing' >&2; exit 1; }
[[ -f "$previous/scripts/maintenance.mjs" ]] && grep -Fq 'durable-v1' "$previous/scripts/maintenance.mjs" || { echo 'Previous release cannot enforce durable maintenance; manual offline rollback required.' >&2; exit 1; }
exec 9>/var/lib/ssh-mcp/.portal-install.lock; flock -n 9
maintenance_reserved=0
if systemctl is-active --quiet ssh-approval-bridge.service; then
  maintenance_new_owner
  /opt/ssh-approval/node/bin/node "$source_dir/scripts/maintenance.mjs" reserve < "$maintenance_owner_file"
  maintenance_reserved=1
fi
for pair in 'ssh-mcp-approval-bridge.env:/etc/ssh-mcp-approval-bridge.env' 'ssh-approval-bridge.service:/etc/systemd/system/ssh-approval-bridge.service' 'ssh-approval-file-helper:/usr/local/libexec/ssh-approval-file-helper'; do
  saved=${pair%%:*}; destination=${pair#*:}
  if [[ -f "$backup/$saved" && ! -L "$backup/$saved" ]]; then cp -a -- "$backup/$saved" "$destination"; fi
done
next=$app/.rollback-next.$$
ln -s -- "$previous" "$next"; mv -Tf -- "$next" "$app/approval-bridge"
systemctl daemon-reload; systemctl restart ssh-approval-bridge.service
mcp_port=$(python3 "$source_dir/scripts/settings_contract.py" port /etc/ssh-mcp-approval-bridge.env mcp)
for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1 && systemctl is-active --quiet ssh-approval-bridge.service; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$mcp_port/health" >/dev/null
systemctl is-active --quiet ssh-approval-bridge.service
if [[ "$maintenance_reserved" == 1 ]]; then
  /opt/ssh-approval/node/bin/node "$source_dir/scripts/maintenance.mjs" release < "$maintenance_owner_file" || { echo 'Maintenance release unconfirmed; manual recovery required.' >&2; exit 1; }
  maintenance_forget_owner
fi
echo "Restored: $previous"
echo 'Existing sudo configuration was preserved.'
