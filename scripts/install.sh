#!/usr/bin/env bash
# Provision a new host only. All release/data activation belongs to deployment.py.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
admin_origin=
manifest_sha256=
grant_sudo=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-origin) admin_origin=${2:?}; shift 2 ;;
    --manifest-sha256) manifest_sha256=${2:?}; shift 2 ;;
    --grant-sudo-all) grant_sudo=1; shift ;;
    *) echo 'Usage: sudo bash scripts/install.sh --manifest-sha256 SHA256 [--admin-origin https://your-admin-domain] [--grant-sudo-all]' >&2; exit 1 ;;
  esac
done
[[ "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || { echo 'An externally verified release-manifest.json SHA256 is required.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Install Python 3 before verifying the installation package.' >&2; exit 1; }
bootstrap=$source_dir/scripts/deployment-bootstrap.py
python3 -I -B "$bootstrap" preflight --source "$source_dir" --manifest-sha256 "$manifest_sha256"
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" =~ ^(22.04|24.04)$ ]] || { echo 'Supported Ubuntu versions: 22.04, 24.04' >&2; exit 1; }
case "$(uname -m)" in x86_64|aarch64) ;; *) echo 'Unsupported CPU' >&2; exit 1;; esac
if systemctl is-active --quiet ssh-approval-bridge.service; then
  echo 'Existing service: use portal.py deploy plan/apply/status/resume.' >&2; exit 1
fi
# A Compose bridge is also an existing installation; never replace it in-place.
if command -v docker >/dev/null; then
  compose_bridge=$(docker ps --filter label=com.docker.compose.project=ssh-approval-portal --filter label=com.docker.compose.service=bridge -q) || { echo 'Cannot confirm Compose state.' >&2; exit 1; }
  [[ -z "$compose_bridge" ]] || { echo 'Existing Compose service: use the explicit deployment import workflow.' >&2; exit 1; }
fi
base=/var/lib/ssh-mcp
env_file=/etc/ssh-mcp-approval-bridge.env
grant=/etc/sudoers.d/90-mcpops-approval-bridge
runtime=/opt/ssh-approval/node
# util-linux is present on supported Ubuntu hosts. Do not install anything before fencing.
command -v flock >/dev/null || { echo 'Install util-linux before running installation.' >&2; exit 1; }
install -d -o root -g root -m 0755 "$base"
umask 077
[[ ! -L "$base/.portal-install.lock" && (! -e "$base/.portal-install.lock" || ( -f "$base/.portal-install.lock" && $(stat -c '%u:%h:%a' "$base/.portal-install.lock") == 0:1:600 )) ]] || { echo 'Unsafe installation lock' >&2; exit 1; }
exec 9>"$base/.portal-install.lock"
flock -n 9 || { echo 'An installation or deployment is already in progress.' >&2; exit 1; }
# Recheck after acquiring the same lock used by the deployment worker.
python3 -I -B "$bootstrap" preflight --source "$source_dir" --manifest-sha256 "$manifest_sha256"
if systemctl is-active --quiet ssh-approval-bridge.service; then
  echo 'Existing service: use portal.py deploy plan/apply/status/resume.' >&2; exit 1
fi
for executable in curl xz ssh-keygen sshd sudo; do
  if ! command -v "$executable" >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl xz-utils python3 openssh-server sudo util-linux
    break
  fi
done
if id mcpops >/dev/null 2>&1; then
  python3 -I -B "$bootstrap" check-home "$(getent passwd mcpops | cut -d: -f6)"
fi
source "$source_dir/scripts/ensure-node-runtime.sh"
node "$source_dir/scripts/verify.mjs" "$source_dir"
if ! id mcpbridge >/dev/null 2>&1; then useradd --system --home-dir "$base" --shell /usr/sbin/nologin mcpbridge; fi
if ! id mcpops >/dev/null 2>&1; then useradd --create-home --shell /bin/bash --password '*' mcpops; fi
install -d -o root -g root -m 0755 "$base/app" "$base/app/releases" /usr/local/libexec
install -d -o mcpbridge -g mcpbridge -m 0700 "$base/.config/ssh-mcp" "$base/.ssh" "$base/.local/share/ssh-mcp" "$base/transfers"
install -d -o root -g root -m 0755 /var/lib/ssh-approval-transfer
install -d -o mcpops -g mcpops -m 0700 /var/lib/ssh-approval-transfer/incoming
key=$base/.ssh/id_ed25519
if [[ ! -e "$key" ]]; then sudo -u mcpbridge ssh-keygen -q -t ed25519 -N '' -f "$key"; fi
public_key=$(sudo -u mcpbridge ssh-keygen -y -P '' -f "$key" | cut -d' ' -f1,2)
if [[ -e "$key.pub" ]]; then
  [[ $(cut -d' ' -f1,2 "$key.pub") == "$public_key" ]] || { echo 'Existing SSH key pair does not match.' >&2; exit 1; }
else
  printf '%s\n' "$public_key" | sudo -u mcpbridge tee "$key.pub" >/dev/null
  sudo -u mcpbridge chmod 0644 "$key.pub"
fi
ssh-keygen -A
pin=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')
config=$base/.config/ssh-mcp/config.toml
sudo -u mcpbridge tee "$config" < "$source_dir/config/config.example.toml" >/dev/null
sudo -u mcpbridge sed -i "s|HOST_KEY_FINGERPRINT|$pin|g" "$config"
sudo -u mcpbridge chmod 0600 "$config"
home_ops=$(getent passwd mcpops | cut -d: -f6)
python3 -I -B "$bootstrap" check-home "$home_ops"
install -d -o mcpops -g mcpops -m 0700 "$home_ops/.ssh"
auth_keys=$home_ops/.ssh/authorized_keys
sudo -u mcpops touch "$auth_keys"; sudo -u mcpops chmod 0600 "$auth_keys"
# Preserve restrictions on an already authorized key instead of adding a wider duplicate.
sudo -u mcpops awk -v key="$public_key" '!/^[[:space:]]*#/ { for (i=1; i<NF; i++) if ($i " " $(i+1) == key) found=1 } END { exit !found }' "$auth_keys" || printf '%s\n' "$public_key" | sudo -u mcpops tee -a "$auth_keys" >/dev/null
node "$source_dir/scripts/generate-secrets.mjs" "$env_file" "$admin_origin"
install -o root -g root -m 0755 "$source_dir/helper/file-helper.py" /usr/local/libexec/ssh-approval-file-helper
if [[ "$grant_sudo" == 1 && ! -e "$grant" ]]; then
  printf '%s\n' 'mcpops ALL=(ALL:ALL) NOPASSWD: ALL' > "$grant"
  chmod 0440 "$grant"; visudo -cf "$grant" >/dev/null
fi
systemctl enable --now ssh.service
# The executor owns the lock from here. No old symlink, backup or rollback path exists.
exec 9>&-
exec python3 -I -B "$bootstrap" start --source "$source_dir" --manifest-sha256 "$manifest_sha256"
