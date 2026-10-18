#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $# == 0 ]] || { echo 'Run as root without arguments.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# Do not change the web process identity, sudo grants or NoNewPrivileges.
install -d -o root -g root -m 0700 /var/lib/ssh-approval-env
install -o root -g root -m 0755 "$source_dir/helper/environment-helper.py" /usr/local/libexec/ssh-approval-environment-helper
install -o root -g root -m 0644 "$source_dir/config/ssh-approval-env.socket" /etc/systemd/system/ssh-approval-env.socket
install -o root -g root -m 0644 "$source_dir/config/ssh-approval-env@.service" /etc/systemd/system/ssh-approval-env@.service
systemd-analyze verify /etc/systemd/system/ssh-approval-env.socket /etc/systemd/system/ssh-approval-env@.service
systemctl daemon-reload
systemctl enable --now ssh-approval-env.socket
echo 'ENV editor enabled. The bridge must run the release containing this feature.'
