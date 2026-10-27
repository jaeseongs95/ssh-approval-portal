#!/usr/bin/env bash
set -euo pipefail
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/scripts" "$work/bin" "$work/app/backups/one" "$work/app/releases/prior/scripts"
printf '%s\n' "$work/app/releases/prior" > "$work/app/backups/one/previous-active"
printf '%s\n' 'durable-v1' > "$work/app/releases/prior/scripts/maintenance.mjs"
printf '%s\n' 'original' > "$work/app/original-marker"
cp "$source_root/scripts/maintenance-owner.sh" "$work/scripts/maintenance-owner.sh"
sed -e "s|^app=/var/lib/ssh-mcp/app$|app=$work/app|" \
    -e "s|exec 9>/var/lib/ssh-mcp/.portal-install.lock|exec 9>$work/portal-install.lock|" \
    "$source_root/scripts/rollback.sh" > "$work/scripts/rollback.sh"
printf '#!/usr/bin/env bash\nprintf "0\\n"\n' > "$work/bin/id"
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/flock"
printf '#!/usr/bin/env bash\nif [[ "$*" == "is-active --quiet ssh-approval-bridge.service" ]]; then exit 3; fi\nprintf "unexpected systemctl call\\n" >> "$TRACE"; exit 1\n' > "$work/bin/systemctl"
chmod +x "$work/bin/id" "$work/bin/flock" "$work/bin/systemctl"
export PATH="$work/bin:$PATH" TRACE="$work/trace"
if bash "$work/scripts/rollback.sh" "$work/app/backups/one" > "$work/output" 2>&1; then
  echo 'A stopped service unexpectedly allowed rollback.' >&2; exit 1
fi
grep -Fq 'independently verified offline rollback is required' "$work/output"
[[ ! -e "$work/trace" && ! -e "$work/app/approval-bridge" ]]
[[ $(cat "$work/app/original-marker") == original ]]
