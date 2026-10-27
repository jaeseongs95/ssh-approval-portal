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
cleanup() { sudo "${compose[@]}" down --remove-orphans || true; }
trap cleanup EXIT
sudo install -d -m 0755 /var/lib/ssh-mcp /etc/ssh-approval-portal
sudo install -d -m 0755 /opt/ssh-approval/node/bin
sudo ln -s "$(command -v node)" /opt/ssh-approval/node/bin/node
sudo install -d -m 0700 -o 10001 -g 10001 /var/lib/ssh-mcp/.ssh /var/lib/ssh-mcp/.config/ssh-mcp /var/lib/ssh-mcp/.local/share/ssh-mcp /var/lib/ssh-mcp/transfers
sudo ssh-keygen -q -t ed25519 -N '' -f /var/lib/ssh-mcp/.ssh/id_ed25519
sudo chown 10001:10001 /var/lib/ssh-mcp/.ssh/id_ed25519 /var/lib/ssh-mcp/.ssh/id_ed25519.pub
pin=$(sudo ssh-keygen -lf /var/lib/ssh-mcp/.ssh/id_ed25519.pub | awk '{print $2}')
sed "s|HOST_KEY_FINGERPRINT|$pin|g" "$source_dir/config/config.example.toml" | sudo tee /var/lib/ssh-mcp/.config/ssh-mcp/config.toml >/dev/null
sudo chown 10001:10001 /var/lib/ssh-mcp/.config/ssh-mcp/config.toml
sudo chmod 0600 /var/lib/ssh-mcp/.config/ssh-mcp/config.toml
printf 'BRIDGE_MCP_TOKEN=synthetic-mcp\nBRIDGE_ADMIN_TOKEN=synthetic-admin\nBRIDGE_ADMIN_ORIGIN=https://example.test\nBRIDGE_UI_TICKET_KEY=%064d\nBRIDGE_UI_ENABLED=true\nBRIDGE_COMMAND_AUTOMATION=true\n' 0 | sudo tee /etc/ssh-approval-portal/docker-secrets.env >/dev/null
sudo chmod 0644 /etc/ssh-approval-portal/docker-secrets.env
sudo python3 -c 'import json,os,sqlite3; p="/var/lib/ssh-mcp/transfers/command-automation.sqlite"; d=sqlite3.connect(p); d.executescript("CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL);"); d.execute("INSERT INTO policy VALUES (1,0,?)",(json.dumps({"targets":[]}),)); i="a"*48; j={"id":i,"state":"completed","kind":"command","targetId":"default","operation":{"kind":"command","command":"true"}}; d.execute("INSERT INTO requests VALUES (?,?,?,?)",(i,None,"b"*64,json.dumps(j))); d.commit(); d.close(); os.chown(p,10001,10001); os.chmod(p,0o600)'
printf 'BRIDGE_UID=10001\nBRIDGE_GID=10001\nBRIDGE_IMAGE=%s\n' "$legacy" | sudo tee "$BRIDGE_COMPOSE_ENV_FILE" >/dev/null
python3 scripts/package.py
version=$(node -p 'require("./package.json").version')
docker build --build-arg "PACKAGE_ARCHIVE=dist/ssh-approval-portal-${version}.tar.gz" -f docker/Dockerfile -t "$candidate" .
candidate_id=$(docker image inspect "$candidate" --format '{{.Id}}')
sudo install -d -m 0700 /etc/ssh-approval-portal/trusted-images
printf '%s\n' "$candidate_id" | sudo tee "/etc/ssh-approval-portal/trusted-images/${candidate_id#sha256:}.sha256" >/dev/null
sudo chmod 0600 "/etc/ssh-approval-portal/trusted-images/${candidate_id#sha256:}.sha256"
printf 'FROM %s\nLABEL ci.fixture=baseline\n' "$candidate" | docker build -t "$baseline" -
baseline_id=$(docker image inspect "$baseline" --format '{{.Id}}')
printf '%s\n' "$baseline_id" | sudo tee "/etc/ssh-approval-portal/trusted-images/${baseline_id#sha256:}.sha256" >/dev/null
sudo chmod 0600 "/etc/ssh-approval-portal/trusted-images/${baseline_id#sha256:}.sha256"
untrusted="ssh-compose-untrusted:${GITHUB_RUN_ID}"
printf 'FROM %s\nLABEL ci.fixture=untrusted\n' "$candidate" | docker build -t "$untrusted" -
malicious="ssh-compose-malicious:${GITHUB_RUN_ID}"
probe_dir=$(mktemp -d)
printf 'if (process.argv.some(x => x.endsWith("bridge.mjs"))) require("fs").writeFileSync("/tmp/injected-marker", "bad");\n' > "$probe_dir/injected.cjs"
printf 'FROM %s\nENV NODE_OPTIONS=--require=/tmp/injected.cjs\nCOPY injected.cjs /tmp/injected.cjs\n' "$candidate" | docker build -t "$malicious" -f - "$probe_dir"
malicious_id=$(docker image inspect "$malicious" --format '{{.Id}}')
printf '%s\n' "$malicious_id" | sudo tee "/etc/ssh-approval-portal/trusted-images/${malicious_id#sha256:}.sha256" >/dev/null
sudo chmod 0600 "/etc/ssh-approval-portal/trusted-images/${malicious_id#sha256:}.sha256"
legacy_dir=$(mktemp -d)
git archive 9644117aa904bcf6a6fd861b741942db3d42035c | tar -x -C "$legacy_dir"
(cd "$legacy_dir" && python3 scripts/package.py && docker build -f docker/Dockerfile -t "$legacy" .)
legacy_id=$(docker image inspect "$legacy" --format '{{.Id}}')
printf '%s\n' "$legacy_id" | sudo tee "/etc/ssh-approval-portal/trusted-images/${legacy_id#sha256:}.sha256" >/dev/null
sudo chmod 0600 "/etc/ssh-approval-portal/trusted-images/${legacy_id#sha256:}.sha256"
"${compose[@]}" up -d --no-build --wait --wait-timeout 90
old=$("${compose[@]}" ps -q bridge)
docker exec "$old" node test/delivery-runtime.mjs
trust_file="/etc/ssh-approval-portal/trusted-images/${candidate_id#sha256:}.sha256"
sudo chmod 0644 "$trust_file"
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"; then
  echo 'A trust record readable by others was unexpectedly accepted' >&2; exit 1
fi
sudo chmod 0600 "$trust_file"
sudo mv "$trust_file" "$trust_file.saved"
sudo ln -s "$trust_file.saved" "$trust_file"
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"; then
  echo 'A symlink trust record was unexpectedly accepted' >&2; exit 1
fi
sudo rm "$trust_file"
sudo mv "$trust_file.saved" "$trust_file"
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$untrusted"; then
  echo 'An image without a trusted ID was unexpectedly accepted' >&2; exit 1
fi
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"; then
  echo 'A legacy bridge was unexpectedly accepted' >&2; exit 1
fi
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
[[ $(docker inspect "$old" --format '{{.Image}}') == "$(docker image inspect "$legacy" --format '{{.Id}}')" ]]
BRIDGE_IMAGE="$baseline" "${compose[@]}" up -d --no-build --wait --wait-timeout 90
old=$("${compose[@]}" ps -q bridge)
baseline_trust="/etc/ssh-approval-portal/trusted-images/${baseline_id#sha256:}.sha256"
sudo mv "$baseline_trust" "$baseline_trust.saved"
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"; then
  echo 'An existing image without a trusted ID was unexpectedly accepted' >&2; exit 1
fi
sudo mv "$baseline_trust.saved" "$baseline_trust"
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$malicious"; then
  echo 'An image containing an untrusted Node preload was unexpectedly accepted' >&2; exit 1
fi
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
mkdir -p "$RUNNER_TEMP/compose-nested"
cat > "$RUNNER_TEMP/compose-nested.yaml" <<YAML
services:
  bridge:
    volumes:
      - $RUNNER_TEMP/compose-nested:/var/lib/ssh-mcp/transfers/nested
YAML
BRIDGE_IMAGE="$baseline" "${compose[@]}" -f "$RUNNER_TEMP/compose-nested.yaml" up -d --no-build --force-recreate --wait --wait-timeout 90
nested=$("${compose[@]}" ps -q bridge)
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"; then
  echo 'An existing container with an extra nested mount was unexpectedly accepted' >&2; exit 1
fi
[[ $("${compose[@]}" ps -q bridge) == "$nested" ]]
BRIDGE_IMAGE="$baseline" "${compose[@]}" up -d --no-build --force-recreate --wait --wait-timeout 90
old=$("${compose[@]}" ps -q bridge)
if sudo env BRIDGE_COMPOSE_PROJECT="$project" BRIDGE_COMPOSE_ENV_FILE="$BRIDGE_COMPOSE_ENV_FILE" BRIDGE_COMPOSE_OVERRIDE=/dev/null bash scripts/compose-update.sh "$candidate"; then
  echo 'An unsupported Compose override was unexpectedly accepted' >&2; exit 1
fi
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
sudo sed -i 's/^BRIDGE_UID=10001$/BRIDGE_UID=10002/' "$BRIDGE_COMPOSE_ENV_FILE"
if sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate"; then
  echo 'A changed Compose user was unexpectedly accepted' >&2; exit 1
fi
[[ $("${compose[@]}" ps -q bridge) == "$old" ]]
sudo sed -i 's/^BRIDGE_UID=10002$/BRIDGE_UID=10001/' "$BRIDGE_COMPOSE_ENV_FILE"
sudo --preserve-env=BRIDGE_COMPOSE_PROJECT,BRIDGE_COMPOSE_ENV_FILE bash scripts/compose-update.sh "$candidate" | tee "$RUNNER_TEMP/compose-update-result.txt"
grep -F '"commandRequestsChecked":1' "$RUNNER_TEMP/compose-update-result.txt"
new=$(sudo "${compose[@]}" ps -q bridge)
[[ -n "$new" && "$old" != "$new" ]]
[[ $(docker inspect "$new" --format '{{.Image}}') == "$(docker image inspect "$candidate" --format '{{.Id}}')" ]]
docker exec "$new" node test/delivery-runtime.mjs
echo 'Actual Compose durable image replacement, restart comparison and release PASS'
