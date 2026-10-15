#!/usr/bin/env bash
set -euo pipefail
env_file=/etc/ssh-approval-portal/compose.env
sed -i "s|^BRIDGE_IMAGE=.*|BRIDGE_IMAGE=$1|" "$env_file"
printf '%s\n' '# synthetic administrator annotation' 'COMPOSE_PROFILES=preserved-fixture' >> "$env_file"
cp -a -- "$env_file" /root/compose-before.env
bash /source/scripts/prepare-docker.sh
grep -Fqx "BRIDGE_IMAGE=$1" "$env_file"
grep -Fqx 'COMPOSE_PROFILES=preserved-fixture' "$env_file"
grep -Fqx '# synthetic administrator annotation' "$env_file"
grep -Fqx "BRIDGE_UID=$(id -u mcpbridge)" "$env_file"
grep -Fqx "BRIDGE_GID=$(id -g mcpbridge)" "$env_file"
