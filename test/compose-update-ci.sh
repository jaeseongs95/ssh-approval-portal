#!/usr/bin/env bash
set -euo pipefail
# Disposable GitHub-hosted runner only. These paths must not exist before the test.
[[ ! -e /var/lib/ssh-mcp && ! -e /etc/ssh-approval-portal ]] || { echo 'Fixture paths already exist' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
project="ssh-compose-ci-${GITHUB_RUN_ID:?}"
candidate="ssh-compose-candidate:${GITHUB_RUN_ID}"
baseline="ssh-compose-baseline:${GITHUB_RUN_ID}"
legacy="ssh-compose-legacy:${GITHUB_RUN_ID}"
export BRIDGE_COMPOSE_PROJECT="$project"
export BRIDGE_COMPOSE_ENV_FILE=/etc/ssh-approval-portal/compose.env
compose=(docker compose -p "$project" --env-file "$BRIDGE_COMPOSE_ENV_FILE" -f "$source_dir/docker/compose.yaml")
cleanup() { "${compose[@]}" down --remove-orphans || true; }
trap cleanup EXIT
sudo install -d -m 0755 /var/lib/ssh-mcp /etc/ssh-approval-portal
sudo install -d -m 0700 -o 10001 -g 10001 /var/lib/ssh-mcp/.ssh /var/lib/ssh-mcp/.config/ssh-mcp /var/lib/ssh-mcp/.local/share/ssh-mcp /var/lib/ssh-mcp/transfers
sudo ssh-keygen -q -t ed25519 -N '' -f /var/lib/ssh-mcp/.ssh/id_ed25519
sudo chown 10001:10001 /var/lib/ssh-mcp/.ssh/id_ed25519 /var/lib/ssh-mcp/.ssh/id_ed25519.pub
pin=$(ssh-keygen -lf /var/lib/ssh-mcp/.ssh/id_ed25519.pub | awk '{print $2}')
sed "s|HOST_KEY_FINGERPRINT|$pin|g" "$source_dir/config/config.example.toml" | sudo tee /var/lib/ssh-mcp/.config/ssh-mcp/config.toml >/dev/null
sudo chown 10001:10001 /var/lib/ssh-mcp/.config/ssh-mcp/config.toml
sudo chmod 0600 /var/lib/ssh-mcp/.config/ssh-mcp/config.toml
printf 'BRIDGE_MCP_TOKEN=synthetic-mcp\nBRIDGE_ADMIN_TOKEN=synthetic-admin\nBRIDGE_ADMIN_ORIGIN=https://example.test\nBRIDGE_UI_TICKET_KEY=%064d\nBRIDGE_UI_ENABLED=true\nBRIDGE_COMMAND_AUTOMATION=true\n' 0 | sudo tee /etc/ssh-approval-portal/docker-secrets.env >/dev/null
sudo chmod 0644 /etc/ssh-approval-portal/docker-secrets.env
printf 'BRIDGE_UID=10001\nBRIDGE_GID=10001\nBRIDGE_IMAGE=%s\n' "$legacy" | sudo tee "$BRIDGE_COMPOSE_ENV_FILE" >/dev/null
python3 scripts/package.py
version=$(node -p 'require("./package.json").version')
docker build --build-arg "PACKAGE_ARCHIVE=dist/ssh-approval-portal-${version}.tar.gz" -f docker/Dockerfile -t "$candidate" .
printf 'FROM %s\nLABEL ci.fixture=baseline\n' "$candidate" | docker build -t "$baseline" -
legacy_dir=$(mktemp -d)
git archive 9644117aa904bcf6a6fd861b741942db3d42035c | tar -x -C "$legacy_dir"
(cd "$legacy_dir" && python3 scripts/package.py && docker build -f docker/Dockerfile -t "$legacy" .)
"${compose[@]}" up -d --no-build --wait --wait-timeout 90
old=$("${compose[@]}" ps -q bridge)
docker exec "$old" node test/delivery-runtime.mjs
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"; then
  echo 'A legacy bridge was unexpectedly accepted' >&2; exit 1
fi
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
[[ $(docker inspect "$old" --format '{{.Image}}') == "$(docker image inspect "$legacy" --format '{{.Id}}')" ]]
BRIDGE_IMAGE="$baseline" "${compose[@]}" up -d --no-build --wait --wait-timeout 90
old=$("${compose[@]}" ps -q bridge)
sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"
new=$("${compose[@]}" ps -q bridge)
[[ -n "$new" && "$old" != "$new" ]]
[[ $(docker inspect "$new" --format '{{.Image}}') == "$(docker image inspect "$candidate" --format '{{.Id}}')" ]]
docker exec "$new" node test/delivery-runtime.mjs
echo 'Actual Compose durable image replacement, restart comparison and release PASS'
