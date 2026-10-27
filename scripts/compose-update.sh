#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST' >&2; exit 1; }
image=$1
[[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]+$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
env_file=${BRIDGE_COMPOSE_ENV_FILE:-/etc/ssh-approval-portal/compose.env}
compose=(docker compose -p "${BRIDGE_COMPOSE_PROJECT:-ssh-approval-portal}" --env-file "$env_file" -f "$source_dir/docker/compose.yaml")
[[ -z ${BRIDGE_COMPOSE_OVERRIDE:-} ]] || { echo 'Compose overrides require a separately verified update procedure.' >&2; exit 1; }
candidate=$(docker image inspect "$image" --format '{{.Id}}')
[[ "$candidate" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Candidate must resolve to one immutable image.' >&2; exit 1; }
# A different entrypoint or command can bypass the verified application entirely.
docker image inspect "$candidate" --format '{{json .Config}}' | python3 -c 'import json,sys; c=json.load(sys.stdin); assert c.get("Entrypoint") in (None,[]) and c.get("Cmd")==["node","bridge.mjs"] and c.get("WorkingDir")=="/opt/portal"'
BRIDGE_IMAGE="$candidate" "${compose[@]}" config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin)["services"]["bridge"]; assert c.get("entrypoint") in (None,[]) and c.get("command") in (None,[]) and c.get("working_dir") in (None,"/opt/portal"); roots=[".ssh",".config/ssh-mcp",".local/share/ssh-mcp","transfers"]; expected={"/var/lib/ssh-mcp/"+x for x in roots}; volumes=c.get("volumes",[]); assert len(volumes)==len(expected) and {v.get("target") for v in volumes}==expected and all(v.get("type")=="bind" and v.get("source")==v.get("target") for v in volumes)'
expected=$(sha256sum "$source_dir/release-manifest.json" | cut -d' ' -f1)
verify_node=/opt/ssh-approval/node/bin/node
[[ -x "$verify_node" ]] || { echo 'Verified host Node runtime is required.' >&2; exit 1; }
probe_dir=$(mktemp -d)
probe_container=
cleanup_probe() { [[ -z "$probe_container" ]] || docker rm "$probe_container" >/dev/null; rm -rf -- "$probe_dir"; }
trap cleanup_probe EXIT
probe_container=$(docker create --entrypoint /bin/true "$candidate")
docker cp "$probe_container:/opt/portal/." "$probe_dir"
docker cp "$probe_container:/usr/local/bin/node" "$probe_dir/candidate-node"
[[ $(sha256sum "$probe_dir/candidate-node" | cut -d' ' -f1) == "$(sha256sum "$verify_node" | cut -d' ' -f1)" ]] || { echo 'Candidate Node runtime differs from the verified host runtime.' >&2; exit 1; }
actual=$(sha256sum "$probe_dir/release-manifest.json" | cut -d' ' -f1)
[[ "$actual" == "$expected" ]] || { echo 'Candidate does not match this verified package manifest.' >&2; exit 1; }
"$verify_node" "$source_dir/scripts/verify.mjs" "$probe_dir"
cleanup_probe
trap - EXIT
probe=(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --tmpfs /tmp:rw,noexec,nosuid,size=64m)
# Exercise the candidate's reservation and restart contracts in an isolated filesystem.
"${probe[@]}" --entrypoint node "$candidate" --test test/maintenance-durable.test.mjs test/preservation-integration.test.mjs
exec 9>/var/lib/ssh-mcp/.portal-install.lock
flock -n 9 || { echo 'An installation is already in progress.' >&2; exit 1; }
old_container=$("${compose[@]}" ps -q bridge)
[[ -n "$old_container" ]] || { echo 'A running durable bridge is required; legacy and offline updates are unsupported.' >&2; exit 1; }
docker inspect "$old_container" --format '{{json .Mounts}}' | python3 -c 'import json,sys; roots=[".ssh",".config/ssh-mcp",".local/share/ssh-mcp","transfers"]; expected={"/var/lib/ssh-mcp/"+x for x in roots}; all_mounts=json.load(sys.stdin); mounts=[m for m in all_mounts if m.get("Destination") in expected]; assert len(mounts)==len(expected) and {m.get("Destination") for m in mounts}==expected and all(m.get("Type")=="bind" and m.get("Source")==m.get("Destination") for m in mounts); secrets=[m for m in all_mounts if m.get("Destination")=="/run/secrets/bridge_config"]; assert len(secrets)==1 and secrets[0].get("Type")=="bind" and secrets[0].get("Source")=="/etc/ssh-approval-portal/docker-secrets.env" and not secrets[0].get("RW")'
candidate_user=$(BRIDGE_IMAGE="$candidate" "${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["bridge"]["user"])')
[[ $(docker inspect "$old_container" --format '{{.Config.User}}') == "$candidate_user" ]] || { echo 'Bridge user changed; update requires a separate procedure.' >&2; exit 1; }
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
if((env.BRIDGE_TRANSFER_ROOT ?? "/var/lib/ssh-mcp/transfers")!=="/var/lib/ssh-mcp/transfers") throw Error("Unsupported state directory");
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
