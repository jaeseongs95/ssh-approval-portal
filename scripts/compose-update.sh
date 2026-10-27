#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $# == 1 ]] || { echo 'Usage: sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
image=$1
[[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]+$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
env_file=${BRIDGE_COMPOSE_ENV_FILE:-/etc/ssh-approval-portal/compose.env}
compose=(docker compose -p "${BRIDGE_COMPOSE_PROJECT:-ssh-approval-portal}" --env-file "$env_file" -f "$source_dir/docker/compose.yaml")
if [[ -n ${BRIDGE_COMPOSE_OVERRIDE:-} ]]; then compose+=(-f "$BRIDGE_COMPOSE_OVERRIDE"); fi
candidate=$(docker image inspect "$image" --format '{{.Id}}')
[[ "$candidate" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Candidate must resolve to one immutable image.' >&2; exit 1; }
# A different entrypoint or command can bypass the verified application entirely.
docker image inspect "$candidate" --format '{{json .Config}}' | python3 -c 'import json,sys; c=json.load(sys.stdin); assert c.get("Entrypoint") in (None,[]) and c.get("Cmd")==["node","bridge.mjs"] and c.get("WorkingDir")=="/opt/portal"'
"${compose[@]}" config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin)["services"]["bridge"]; assert c.get("entrypoint") in (None,[]) and c.get("command") in (None,[]) and c.get("working_dir") in (None,"/opt/portal")'
expected=$(sha256sum "$source_dir/release-manifest.json" | cut -d' ' -f1)
actual=$(docker run --rm --network none --entrypoint sha256sum "$candidate" /opt/portal/release-manifest.json | cut -d' ' -f1)
[[ "$actual" == "$expected" ]] || { echo 'Candidate does not match this verified package manifest.' >&2; exit 1; }
docker run --rm --network none --entrypoint node "$candidate" scripts/verify.mjs .
# Exercise the candidate's reservation and restart contracts in an isolated filesystem.
docker run --rm --network none --entrypoint node "$candidate" --test test/maintenance-durable.test.mjs test/preservation-integration.test.mjs
exec 9>/var/lib/ssh-mcp/.portal-install.lock
flock -n 9 || { echo 'An installation is already in progress.' >&2; exit 1; }
old_container=$("${compose[@]}" ps -q bridge)
[[ -n "$old_container" ]] || { echo 'A running durable bridge is required; legacy and offline updates are unsupported.' >&2; exit 1; }
old_image=$(docker inspect "$old_container" --format '{{.Image}}')
[[ "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Running image is not identifiable.' >&2; exit 1; }
. "$source_dir/scripts/maintenance-owner.sh"
maintenance_new_owner
echo "Compose previous image: $old_image; candidate image: $candidate" >&2
maintenance() { "${compose[@]}" exec -T bridge node scripts/maintenance.mjs "$1" < "$maintenance_owner_file"; }
# Do not trust the old image's CLI: legacy versions reserve without owner checks.
"${compose[@]}" exec -T bridge node --input-type=module -e '
import {readFileSync} from "node:fs";
import {loadSecrets} from "./src/adapters/config/secrets.mjs";
import {parseSettings} from "./src/adapters/config/settings.mjs";
const owner=readFileSync(0,"utf8").trim(), env=await loadSecrets(process.env,process.env.BRIDGE_SECRET_ENV_FILE), {adminPort}=parseSettings(env);
if(!/^[a-f0-9]{64}$/.test(owner)) throw Error("Invalid owner");
const response=await fetch(`http://127.0.0.1:${adminPort}/api/maintenance/capabilities`,{method:"POST",headers:{Authorization:"Bearer "+env.BRIDGE_ADMIN_TOKEN,Origin:env.BRIDGE_ADMIN_ORIGIN,"X-Maintenance-Owner":owner},signal:AbortSignal.timeout(5000)});
if(!response.ok || (await response.json()).ownership!=="durable-v1") throw Error("Durable maintenance unavailable");
' < "$maintenance_owner_file" || { echo 'Legacy or unverified bridge; no reservation or image change attempted.' >&2; exit 1; }
# Any uncertain result retains the private owner file; never replay or auto-rollback.
maintenance reserve || { echo 'Reservation failed or is unknown; inspect before recovery.' >&2; exit 1; }
maintenance capture || { echo 'Capture failed or is unknown; maintenance retained.' >&2; exit 1; }
BRIDGE_IMAGE="$candidate" "${compose[@]}" up -d --no-build --wait --wait-timeout 60 || { echo 'Candidate start failed or is unknown; maintenance retained.' >&2; exit 1; }
new_container=$(BRIDGE_IMAGE="$candidate" "${compose[@]}" ps -q bridge)
[[ -n "$new_container" && "$new_container" != "$old_container" ]] || { echo 'New container not confirmed; maintenance retained.' >&2; exit 1; }
[[ $(docker inspect "$new_container" --format '{{.Image}}') == "$candidate" ]] || { echo 'Candidate image mismatch; maintenance retained.' >&2; exit 1; }
maintenance compare || { echo 'Post-restart preservation incomplete; maintenance retained.' >&2; exit 1; }
python3 "$source_dir/scripts/compose-env.py" image "$env_file" "$candidate" || { echo 'Image configuration update failed; maintenance retained.' >&2; exit 1; }
maintenance release || { echo 'Maintenance release failed or is unknown; retain owner for recovery.' >&2; exit 1; }
maintenance_forget_owner
echo "Compose update verified: $candidate; previous image: $old_image"
