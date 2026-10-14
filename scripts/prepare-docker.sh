#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
origin=
grant_sudo=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-origin) origin=${2:?}; shift 2;;
    --grant-sudo-all) grant_sudo=1; shift;;
    *) echo 'Usage: sudo bash scripts/prepare-docker.sh [--admin-origin HTTPS_ORIGIN] [--grant-sudo-all]' >&2; exit 1;;
  esac
done
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" =~ ^(22.04|24.04)$ ]] || { echo 'Ubuntu 22.04/24.04 required' >&2; exit 1; }
for executable in python3 ssh-keygen sshd sudo flock curl; do
  if ! command -v "$executable" >/dev/null; then
    apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y python3 openssh-server sudo util-linux curl ca-certificates; break
  fi
done
base=/var/lib/ssh-mcp
if curl -fsS http://127.0.0.1:39124/health >/dev/null 2>&1; then echo 'A bridge is running: finish requests and stop it before host preparation' >&2; exit 1; fi
install -d -m 0755 "$base/app"
exec 9>"$base/.portal-install.lock"; flock -n 9
if systemctl is-active --quiet ssh-approval-bridge.service; then echo 'Finish requests and stop the native service before preparing Docker' >&2; exit 1; fi
if command -v docker >/dev/null && docker ps --format '{{.Names}}' | grep -Fxq ssh-approval-portal-bridge-1; then echo 'Stop the existing Compose bridge safely before preparing its host files' >&2; exit 1; fi
id mcpbridge >/dev/null 2>&1 || useradd --system --home-dir "$base" --shell /usr/sbin/nologin mcpbridge
id mcpops >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --password '*' mcpops
install -d -o mcpbridge -g mcpbridge -m 0700 "$base/.config/ssh-mcp" "$base/.ssh" "$base/.local/share/ssh-mcp" "$base/transfers"
install -d -o root -g root -m 0755 /var/lib/ssh-approval-transfer /usr/local/libexec
install -d -o mcpops -g mcpops -m 0700 /var/lib/ssh-approval-transfer/incoming
config=$base/.config/ssh-mcp/config.toml
if [[ ! -e "$config" ]]; then
  [[ -e "$base/.ssh/id_ed25519" ]] || sudo -u mcpbridge ssh-keygen -q -t ed25519 -N '' -f "$base/.ssh/id_ed25519"
  ssh-keygen -A
  pin=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')
  cp -- "$source_dir/config/config.example.toml" "$config"; sed -i "s|HOST_KEY_FINGERPRINT|$pin|g" "$config"
  chown mcpbridge:mcpbridge "$config"; chmod 0600 "$config"
  ops_home=$(getent passwd mcpops | cut -d: -f6)
  install -d -o mcpops -g mcpops -m 0700 "$ops_home/.ssh"
  auth=$ops_home/.ssh/authorized_keys
  [[ ! -e "$auth" || (-f "$auth" && ! -L "$auth") ]] || { echo 'Unsafe authorized_keys' >&2; exit 1; }
  touch "$auth"; chown mcpops:mcpops "$auth"; chmod 0600 "$auth"
  key=$(cat "$base/.ssh/id_ed25519.pub"); grep -Fqx -- "$key" "$auth" || printf '%s\n' "$key" >> "$auth"
fi
helper=/usr/local/libexec/ssh-approval-file-helper
if [[ -e "$helper" ]]; then
  [[ -f "$helper" && ! -L "$helper" ]] || { echo 'Unsafe existing helper' >&2; exit 1; }
  cmp -s -- "$helper" "$source_dir/helper/file-helper.py" || { echo 'Existing helper differs: use the verified native updater before migration' >&2; exit 1; }
else install -o root -g root -m 0755 "$source_dir/helper/file-helper.py" "$helper"; fi
grant=/etc/sudoers.d/90-mcpops-approval-bridge
if [[ "$grant_sudo" == 1 && ! -e "$grant" ]]; then
  printf '%s\n' 'mcpops ALL=(ALL:ALL) NOPASSWD: ALL' > "$grant"; chmod 0440 "$grant"; visudo -cf "$grant" >/dev/null
fi
install -d -o root -g mcpbridge -m 0750 /etc/ssh-approval-portal
python3 "$source_dir/scripts/docker-secrets.py" "$origin"
printf 'BRIDGE_UID=%s\nBRIDGE_GID=%s\nBRIDGE_IMAGE=ssh-approval-portal:0.3.0\n' "$(id -u mcpbridge)" "$(id -g mcpbridge)" > /etc/ssh-approval-portal/compose.env
chmod 0600 /etc/ssh-approval-portal/compose.env
systemctl enable --now ssh.service
echo 'Docker host prepared. Keys/settings/sudo were preserved. Use /etc/ssh-approval-portal/compose.env with Compose.'
