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
if bash scripts/compose-update.sh "$TEST_IMAGE"; then echo 'Unsupported Compose update unexpectedly succeeded' >&2; exit 1; fi
[[ $(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}') == "$baseline_id" ]]
[[ $(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env") == "$before" ]]
verify_state
ssh_roundtrip
echo "ACTUAL COMPOSE: SSH roundtrip and unchanged image, secrets, and state after rejected update PASS; image update and rollback are unsupported"
