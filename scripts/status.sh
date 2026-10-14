#!/usr/bin/env bash
set -euo pipefail
systemctl status ssh-approval-bridge.service --no-pager --lines=0
curl -fsS http://127.0.0.1:39124/health
printf '\n'
systemctl show ssh-approval-bridge.service -p Requires -p After -p FragmentPath
ss -ltn 'sport = :39124 or sport = :39125 or sport = :39123'
