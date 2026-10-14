#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $# == 1 ]] || { echo 'Usage: sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
image=$1
[[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]+$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
env_file=${BRIDGE_COMPOSE_ENV_FILE:-/etc/ssh-approval-portal/compose.env}
exec 9>/var/lib/ssh-mcp/.portal-install.lock; flock -n 9
compose=(docker compose -p "${BRIDGE_COMPOSE_PROJECT:-ssh-approval-portal}" --env-file "$env_file" -f "$source_dir/docker/compose.yaml")
if [[ -n ${BRIDGE_COMPOSE_OVERRIDE:-} ]]; then compose+=(-f "$BRIDGE_COMPOSE_OVERRIDE"); fi
docker image inspect "$image" >/dev/null
old_image=$(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}')
backup=/var/lib/ssh-mcp/app/backups/compose-$(date -u +%Y%m%dT%H%M%SZ)-$$
install -d -m 0700 "$backup"; cp -a -- "$env_file" "$backup/compose.env"
"${compose[@]}" exec -T bridge node scripts/maintenance.mjs reserve
restore() {
  rc=$?; [[ "$rc" == 0 ]] && return
  set +e
  cp -a -- "$backup/compose.env" "$env_file"
  failed=0
  BRIDGE_IMAGE="$old_image" "${compose[@]}" up -d --no-build --wait --wait-timeout 30 || failed=1
  sed -i "s|^BRIDGE_IMAGE=.*|BRIDGE_IMAGE=$old_image|" "$env_file" || failed=1
  BRIDGE_IMAGE="$old_image" "${compose[@]}" exec -T bridge node scripts/maintenance.mjs release || failed=1
  echo "Compose update failed. Prior image restore attempted; failures=$failed; backup=$backup" >&2
  exit "$rc"
}
trap restore EXIT
BRIDGE_IMAGE="$image" "${compose[@]}" up -d --no-build --wait --wait-timeout 30
sed -i "s|^BRIDGE_IMAGE=.*|BRIDGE_IMAGE=$image|" "$env_file"
BRIDGE_IMAGE="$image" "${compose[@]}" exec -T bridge node scripts/maintenance.mjs release
trap - EXIT
echo "Compose running image: $image; rollback image: $old_image; backup=$backup"
