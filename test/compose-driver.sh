#!/usr/bin/env bash
set -euo pipefail
# Test controller only: its Docker socket controls the named synthetic fixtures below.
# The production bridge never mounts a Docker socket or receives privileged mode.
export BRIDGE_COMPOSE_PROJECT=$TEST_PROJECT
export BRIDGE_COMPOSE_ENV_FILE=/work/compose.env
export BRIDGE_COMPOSE_OVERRIDE=/work/override.yaml
mkdir /work
starting_image=${TEST_BASELINE_IMAGE:-$TEST_IMAGE}
printf 'BRIDGE_UID=%s\nBRIDGE_GID=%s\nBRIDGE_IMAGE=%s\n' "$TEST_UID" "$TEST_GID" "$starting_image" > "$BRIDGE_COMPOSE_ENV_FILE"
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
trap '"${compose[@]}" down || true' EXIT
"${compose[@]}" up -d --no-build --wait --wait-timeout 45
"${compose[@]}" exec -T bridge node test/ssh-roundtrip.mjs
baseline_id=$(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}')
before=$(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env")
bash scripts/compose-update.sh "$TEST_IMAGE"
"${compose[@]}" exec -T bridge node test/delivery-runtime.mjs
"${compose[@]}" exec -T bridge node test/ssh-roundtrip.mjs
if [[ -n ${TEST_BASELINE_IMAGE:-} ]]; then
  bash scripts/compose-update.sh "$baseline_id"
  [[ $(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}') == "$baseline_id" ]]
  [[ $(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env") == "$before" ]]
  bash scripts/compose-update.sh "$TEST_IMAGE"
fi
# The old baseline image healthcheck uses the default port. Verify its real
# upgrade/rollback first, then exercise candidate custom ports independently.
"${compose[@]}" exec -T bridge node scripts/maintenance.mjs reserve
"${compose[@]}" down
docker exec "$TEST_TARGET" python3 /source/test/delivery-fixture.py docker-settings /etc/ssh-approval-portal/docker-secrets.env
BRIDGE_IMAGE="$TEST_IMAGE" "${compose[@]}" up -d --no-build --wait --wait-timeout 45
old=$(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}')
before=$(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env")
bash scripts/compose-update.sh "$TEST_IMAGE"
"${compose[@]}" exec -T bridge node test/delivery-runtime.mjs
mkdir /work/broken
printf 'FROM %s\nCMD ["node","test/broken-start.fixture.mjs"]\n' "$TEST_IMAGE" > /work/broken/Dockerfile
broken=$TEST_PROJECT:broken
docker build --label "io.ssh-approval.solid-task=$TEST_TASK_TAG" -t "$broken" /work/broken
if bash scripts/compose-update.sh "$broken"; then echo 'Broken image update unexpectedly succeeded' >&2; exit 1; fi
[[ $(docker inspect "$("${compose[@]}" ps -q bridge)" --format '{{.Image}}') == "$old" ]]
[[ $(sha256sum "$TEST_SECRET_SOURCE/docker-secrets.env") == "$before" ]]
"${compose[@]}" exec -T bridge node test/delivery-runtime.mjs
echo "ACTUAL COMPOSE: secret file, SSH roundtrip, custom ports, idempotent update, failed-start rollback, same image/secret preservation PASS; baseline=${TEST_BASELINE_IMAGE:-none}"
