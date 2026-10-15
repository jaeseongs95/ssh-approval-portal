#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
env_file=/etc/ssh-mcp-approval-bridge.env
mcp_port=$(python3 "$source_dir/scripts/settings_contract.py" port "$env_file" mcp)
admin_port=$(python3 "$source_dir/scripts/settings_contract.py" port "$env_file" admin)
systemctl status ssh-approval-bridge.service --no-pager --lines=0
curl -fsS "http://127.0.0.1:$mcp_port/health"
printf '\n'
systemctl show ssh-approval-bridge.service -p Requires -p After -p FragmentPath
ss -ltn "sport = :$mcp_port or sport = :$admin_port or sport = :39123"
