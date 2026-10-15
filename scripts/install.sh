#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
admin_origin=
grant_sudo=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-origin) admin_origin=${2:?}; shift 2 ;;
    --grant-sudo-all) grant_sudo=1; shift ;;
    *) echo 'Usage: sudo bash scripts/install.sh [--admin-origin https://your-admin-domain] [--grant-sudo-all]' >&2; exit 1 ;;
  esac
done
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" =~ ^(22.04|24.04)$ ]] || { echo 'Supported Ubuntu versions: 22.04, 24.04' >&2; exit 1; }
case "$(uname -m)" in x86_64) architecture=x64;; aarch64) architecture=arm64;; *) echo 'Unsupported CPU' >&2; exit 1;; esac
for executable in curl xz python3 ssh-keygen sshd sudo flock; do
  if ! command -v "$executable" >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl xz-utils python3 openssh-server sudo util-linux
    break
  fi
done
base=/var/lib/ssh-mcp
app=$base/app
active=$app/approval-bridge
env_file=/etc/ssh-mcp-approval-bridge.env
unit=/etc/systemd/system/ssh-approval-bridge.service
helper=/usr/local/libexec/ssh-approval-file-helper
grant=/etc/sudoers.d/90-mcpops-approval-bridge
runtime=/opt/ssh-approval/node
for secret_file in "$env_file" /etc/ssh-approval-portal/docker-secrets.env; do
  probe_port=$(python3 "$source_dir/scripts/settings_contract.py" port "$secret_file" mcp)
  if ! systemctl is-active --quiet ssh-approval-bridge.service && curl -fsS "http://127.0.0.1:$probe_port/health" >/dev/null 2>&1; then
    echo 'A non-native bridge is running. Reserve maintenance and stop Compose before native installation.' >&2; exit 1
  fi
done
if command -v docker >/dev/null && [[ -n $(docker ps --filter label=com.docker.compose.project=ssh-approval-portal --filter label=com.docker.compose.service=bridge -q) ]]; then
  echo 'Compose bridge is running: stop it safely before native installation.' >&2; exit 1
fi
install -d -m 0755 "$app" /opt/ssh-approval
exec 9>"$base/.portal-install.lock"
flock -n 9 || { echo 'An installation is already in progress' >&2; exit 1; }
maintenance_reserved=0
maintenance_node=$runtime/bin/node
[[ -x "$maintenance_node" ]] || maintenance_node=$(command -v node || true)
release_maintenance() {
  if [[ "$maintenance_reserved" == 1 ]]; then "$maintenance_node" "$source_dir/scripts/maintenance.mjs" release || true; fi
}
trap release_maintenance EXIT
if systemctl is-active --quiet ssh-approval-bridge.service; then
  [[ -x "$maintenance_node" ]] || { echo 'Stop the legacy service in the administrator terminal before updating' >&2; exit 1; }
  "$maintenance_node" "$source_dir/scripts/maintenance.mjs" reserve
  maintenance_reserved=1
fi
source "$source_dir/scripts/ensure-node-runtime.sh"
node "$source_dir/scripts/verify.mjs" "$source_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
backup=$app/backups/$stamp
release_hash=$(sha256sum "$source_dir/release-manifest.json" | cut -c1-16)
release=$app/releases/0.3.0-$release_hash
install -d -m 0700 "$app/backups" "$backup"
for path in "$env_file" "$unit" "$helper"; do
  if [[ -e "$path" ]]; then [[ -f "$path" && ! -L "$path" ]] || { echo 'Expected a regular managed file' >&2; exit 1; }; cp -a -- "$path" "$backup/$(basename "$path")"; fi
done
old_active=
if [[ -L "$active" ]]; then old_active=$(readlink -f -- "$active");
elif [[ -d "$active" ]]; then old_active=$app/approval-bridge.legacy.$stamp;
elif [[ -e "$active" ]]; then echo 'Unexpected active path' >&2; exit 1; fi
printf '%s\n' "$old_active" > "$backup/previous-active"
systemctl is-enabled --quiet ssh-approval-bridge.service && touch "$backup/was-enabled" || true
systemctl is-active --quiet ssh-approval-bridge.service && touch "$backup/was-running" || true
grant_created=0
activated=0
wait_healthy() {
  local mcp_port
  mcp_port=$(python3 "$source_dir/scripts/settings_contract.py" port "$env_file" mcp) || return 1
  for attempt in {1..20}; do
    if curl -fsS "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1 && systemctl is-active --quiet ssh-approval-bridge.service; then return 0; fi
    sleep 1
  done
  return 1
}
restore() {
  rc=$?
  [[ "$rc" == 0 ]] && return
  set +e
  failed=0
  if [[ "$activated" == 1 ]]; then
    rm -f -- "$active"
    if [[ -n "$old_active" ]]; then ln -s -- "$old_active" "$active" || failed=1; fi
  fi
  for path in "$env_file" "$unit" "$helper"; do
    saved=$backup/$(basename "$path")
    if [[ -f "$saved" ]]; then cp -a -- "$saved" "$path" || failed=1; else rm -f -- "$path" || failed=1; fi
  done
  if [[ "$grant_created" == 1 ]]; then rm -f -- "$grant" || failed=1; fi
  systemctl daemon-reload || failed=1
  if [[ -f "$backup/was-running" ]]; then systemctl restart ssh-approval-bridge.service && wait_healthy || failed=1; else systemctl stop ssh-approval-bridge.service || true; fi
  if [[ -f "$backup/was-enabled" ]]; then systemctl enable ssh-approval-bridge.service || failed=1; else systemctl disable ssh-approval-bridge.service || true; fi
  release_maintenance
  echo "Installation failed. Restore attempted; failures=$failed; backup=$backup" >&2
  exit "$rc"
}
trap restore EXIT
if ! id mcpbridge >/dev/null 2>&1; then useradd --system --home-dir "$base" --shell /usr/sbin/nologin mcpbridge; fi
if ! id mcpops >/dev/null 2>&1; then useradd --create-home --shell /bin/bash --password '*' mcpops; fi
install -d -o mcpbridge -g mcpbridge -m 0700 "$base/.config/ssh-mcp" "$base/.ssh" "$base/.local/share/ssh-mcp" "$base/transfers"
install -d -o root -g root -m 0755 /var/lib/ssh-approval-transfer /usr/local/libexec
install -d -o mcpops -g mcpops -m 0700 /var/lib/ssh-approval-transfer/incoming
config=$base/.config/ssh-mcp/config.toml
if [[ ! -e "$config" ]]; then
  if [[ ! -e "$base/.ssh/id_ed25519" ]]; then sudo -u mcpbridge ssh-keygen -q -t ed25519 -N '' -f "$base/.ssh/id_ed25519"; fi
  ssh-keygen -A
  pin=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')
  cp -- "$source_dir/config/config.example.toml" "$config"
  sed -i "s|HOST_KEY_FINGERPRINT|$pin|g" "$config"
  chown mcpbridge:mcpbridge "$config"; chmod 0600 "$config"
  home_ops=$(getent passwd mcpops | cut -d: -f6)
  install -d -o mcpops -g mcpops -m 0700 "$home_ops/.ssh"
  public_key=$(cat "$base/.ssh/id_ed25519.pub")
  auth_keys=$home_ops/.ssh/authorized_keys
  if [[ -e "$auth_keys" && (! -f "$auth_keys" || -L "$auth_keys") ]]; then echo 'Unsafe authorized_keys' >&2; exit 1; fi
  touch "$auth_keys"; chown mcpops:mcpops "$auth_keys"; chmod 0600 "$auth_keys"
  grep -Fqx -- "$public_key" "$auth_keys" || printf '%s\n' "$public_key" >> "$auth_keys"
fi
node "$source_dir/scripts/generate-secrets.mjs" "$env_file" "$admin_origin"
if [[ "$grant_sudo" == 1 && ! -e "$grant" ]]; then
  printf '%s\n' 'mcpops ALL=(ALL:ALL) NOPASSWD: ALL' > "$grant"
  chmod 0440 "$grant"; visudo -cf "$grant" >/dev/null; grant_created=1
fi
if [[ ! -d "$release" ]]; then
  stage=$(mktemp -d "$app/.portal-release.XXXXXXXX")
  cp -a -- "$source_dir"/. "$stage"/
  (cd "$stage"; npm ci --omit=dev --ignore-scripts)
  node --check "$stage/bridge.mjs"
  node "$stage/scripts/check-package-imports.mjs"
  chown -R root:mcpbridge "$stage"
  find "$stage" -type d -exec chmod 0750 {} +
  find "$stage" -type f -exec chmod 0640 {} +
  install -d -m 0755 "$app/releases"
  mv -- "$stage" "$release"
fi
if [[ -d "$active" && ! -L "$active" ]]; then mv -- "$active" "$old_active"; fi
next=$app/.approval-bridge-next.$stamp
ln -s -- "$release" "$next"
mv -Tf -- "$next" "$active"
activated=1
install -o root -g root -m 0755 "$source_dir/helper/file-helper.py" "$helper"
if [[ -e "$unit" ]]; then
  grep -Fqx 'ExecStart=/usr/bin/node /var/lib/ssh-mcp/app/approval-bridge/bridge.mjs' "$unit" || grep -Fqx "ExecStart=$runtime/bin/node /var/lib/ssh-mcp/app/approval-bridge/bridge.mjs" "$unit" || { echo 'Custom ExecStart: update the unit explicitly' >&2; exit 1; }
  sed -i "s|^ExecStart=/usr/bin/node |ExecStart=$runtime/bin/node |" "$unit"
else install -o root -g root -m 0644 "$source_dir/config/ssh-approval-bridge.service" "$unit"; fi
systemd-analyze verify "$unit"
systemctl daemon-reload
systemctl enable --now ssh.service
systemctl enable ssh-approval-bridge.service
systemctl restart ssh-approval-bridge.service
wait_healthy
trap - EXIT
echo "Installed release: $release"
echo "Rollback backup: $backup"
echo 'UI approval remains governed by BRIDGE_UI_ENABLED. Run the harmless host probe before enabling it.'
