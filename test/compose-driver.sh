#!/usr/bin/env bash
set -euo pipefail
# Test controller only: its Docker socket controls the named synthetic fixtures below.
# The production bridge never mounts a Docker socket or receives privileged mode.
export BRIDGE_COMPOSE_PROJECT=$TEST_PROJECT
export BRIDGE_COMPOSE_ENV_FILE=/work/compose.env
export BRIDGE_COMPOSE_OVERRIDE=/work/override.yaml
mkdir /work
starting_image=${TEST_BASELINE_IMAGE:-$TEST_IMAGE}
printf 'BRIDGE_UID=%s\nBRIDGE_GID=%s\nexport BRIDGE_IMAGE : "%s" # preserved administrator syntax\n' "$TEST_UID" "$TEST_GID" "$starting_image" > "$BRIDGE_COMPOSE_ENV_FILE"
cat > "$BRIDGE_COMPOSE_OVERRIDE" <<YAML
services:
  bridge:
    labels:
      io.ssh-approval.solid-task: $TEST_TASK_TAG
    network_mode: container:$TEST_TARGET
    environment:
      BRIDGE_TEST_ENV_FILE: /run/secrets/bridge_config
    volumes: !override
      - type: volume
        source: fixture_state
        target: /var/lib/ssh-mcp/.ssh
        read_only: true
        volume: {subpath: .ssh}
      - type: volume
        source: fixture_state
        target: /var/lib/ssh-mcp/.config/ssh-mcp
        read_only: true
        volume: {subpath: .config/ssh-mcp}
      - type: volume
        source: fixture_state
        target: /var/lib/ssh-mcp/.local/share/ssh-mcp
        volume: {subpath: .local/share/ssh-mcp}
      - type: volume
        source: fixture_state
        target: /var/lib/ssh-mcp/transfers
        volume: {subpath: transfers}
secrets:
  bridge_config:
    file: $TEST_SECRET_SOURCE/docker-secrets.env
volumes:
  fixture_state:
    external: true
    name: $TEST_STATE
YAML
compose=(docker compose -p "$TEST_PROJECT" --env-file "$BRIDGE_COMPOSE_ENV_FILE" -f docker/compose.yaml -f "$BRIDGE_COMPOSE_OVERRIDE")
cleanup() {
  rc=$?
  if [[ "$rc" != 0 ]]; then
    # Synthetic fixtures only: retain startup/probe evidence before removing them.
    "${compose[@]}" logs --no-color --tail 30 bridge || true
    id=$("${compose[@]}" ps -a -q bridge) || true
    [[ -z "$id" ]] || docker inspect "$id" --format '{{json .State.Health}}' || true
  fi
  "${compose[@]}" down || true
  exit "$rc"
}
trap cleanup EXIT
mkdir -m 0700 /var/lib/ssh-mcp/compose-proof
chown "$TEST_UID:$TEST_GID" /var/lib/ssh-mcp/compose-proof
probe() {
  # One current protocol oracle for baseline and candidate; do not run stale image tests.
  docker run --rm --name "$TEST_PROJECT-probe" --label "io.ssh-approval.solid-task=$TEST_TASK_TAG" \
    --network "container:$TEST_TARGET" --user "$TEST_UID:$TEST_GID" --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 128 \
    --env BRIDGE_TEST_ENV_FILE=/run/secrets/bridge_config \
    --mount "type=bind,src=$TEST_SECRET_SOURCE/docker-secrets.env,target=/run/secrets/bridge_config,readonly" \
    --mount "type=volume,src=$TEST_STATE,target=/proof,volume-subpath=compose-proof" \
    "$TEST_IMAGE" node "$@"
}
ssh_roundtrip() { probe test/ssh-roundtrip.mjs; }
config_before=$(sha256sum /var/lib/ssh-mcp/.config/ssh-mcp/config.toml)
verify_state() {
  [[ $(sha256sum /var/lib/ssh-mcp/.config/ssh-mcp/config.toml) == "$config_before" ]]
  probe test/compose-state.mjs verify
}
# This synthetic preservation case needs the durable policy/journal API enabled.
docker exec "$TEST_TARGET" sed -i 's/^BRIDGE_COMMAND_AUTOMATION=false$/BRIDGE_COMMAND_AUTOMATION=true/' /etc/ssh-approval-portal/docker-secrets.env
docker exec "$TEST_TARGET" grep -Fqx BRIDGE_COMMAND_AUTOMATION=true /etc/ssh-approval-portal/docker-secrets.env
"${compose[@]}" up -d --no-build --wait --wait-timeout 45
ssh_roundtrip
probe test/compose-state.mjs capture
baseline_id=$(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}')
before=$(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env")
bash scripts/compose-update.sh "$TEST_IMAGE"
verify_state
[[ $("${compose[@]}" config --images) == "$TEST_IMAGE" ]]
"${compose[@]}" exec -T bridge node test/delivery-runtime.mjs
ssh_roundtrip
if [[ -n ${TEST_BASELINE_IMAGE:-} ]]; then
  bash scripts/compose-update.sh "$baseline_id"
  [[ $("${compose[@]}" config --images) == "$baseline_id" ]]
  [[ $(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}') == "$baseline_id" ]]
  [[ $(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env") == "$before" ]]
  verify_state
  bash scripts/compose-update.sh "$TEST_IMAGE"
  verify_state
fi
# The old baseline image healthcheck uses the default port. Verify its real
# upgrade/rollback first, then exercise candidate custom ports independently.
"${compose[@]}" exec -T bridge node scripts/maintenance.mjs reserve
"${compose[@]}" down
docker exec "$TEST_TARGET" python3 /source/test/delivery-fixture.py docker-settings /etc/ssh-approval-portal/docker-secrets.env
BRIDGE_IMAGE="$TEST_IMAGE" "${compose[@]}" up -d --no-build --wait --wait-timeout 45
verify_state
old=$(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}')
before=$(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env")
bash scripts/compose-update.sh "$TEST_IMAGE"
verify_state
"${compose[@]}" exec -T bridge node test/delivery-runtime.mjs
mkdir /work/broken
printf 'FROM %s\nCMD ["node","test/broken-start.fixture.mjs"]\n' "$TEST_IMAGE" > /work/broken/Dockerfile
broken=$TEST_PROJECT:broken
platform=$(docker image inspect "$TEST_IMAGE" --format '{{.Os}}/{{.Architecture}}')
docker build --platform "$platform" --label "io.ssh-approval.solid-task=$TEST_TASK_TAG" -t "$broken" /work/broken
if bash scripts/compose-update.sh "$broken"; then echo 'Broken image update unexpectedly succeeded' >&2; exit 1; fi
[[ $("${compose[@]}" config --images) == "$old" ]]
[[ $(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}') == "$old" ]]
[[ $(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env") == "$before" ]]
verify_state
"${compose[@]}" exec -T bridge node test/delivery-runtime.mjs
echo "ACTUAL COMPOSE: secret file, SSH roundtrip, custom ports, idempotent update, failed-start rollback, same image/secret preservation PASS; baseline=${TEST_BASELINE_IMAGE:-none}"
