#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST' >&2; exit 1; }
image=$1
[[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]+$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
env_file=${BRIDGE_COMPOSE_ENV_FILE:-/etc/ssh-approval-portal/compose.env}
env_fingerprint() {
  /usr/bin/python3 -I -c 'import hashlib,os,stat,sys; from pathlib import Path; path=os.path.abspath(sys.argv[1]); parent=os.path.dirname(path); dirs=[parent,*map(str,Path(parent).parents)]; assert os.path.realpath(parent)==parent and all(stat.S_ISDIR(os.lstat(d).st_mode) and not stat.S_ISLNK(os.lstat(d).st_mode) and os.lstat(d).st_uid==0 and not(os.lstat(d).st_mode&0o022) for d in dirs); fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not(s.st_mode&0o022) and s.st_nlink==1 and s.st_size<=1048576; f=os.fdopen(fd,"rb"); data=f.read(1048577); f.close(); assert len(data)==s.st_size; print(hashlib.sha256(data).hexdigest())' "$env_file"
}
before_env=$(env_fingerprint) || { echo 'Unsafe Compose environment file.' >&2; exit 1; }
compose=(docker compose -p "${BRIDGE_COMPOSE_PROJECT:-ssh-approval-portal}" --env-file "$env_file" -f "$source_dir/docker/compose.yaml")
[[ -z ${BRIDGE_COMPOSE_OVERRIDE:-} ]] || { echo 'Compose overrides require a separately verified update procedure.' >&2; exit 1; }
candidate=$(docker image inspect "$image" --format '{{.Id}}')
[[ "$candidate" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Candidate must resolve to one immutable image.' >&2; exit 1; }
trusted_image() {
  /usr/bin/python3 -I -c 'import os,stat,sys; image=sys.argv[1]; base="/etc/ssh-approval-portal/trusted-images"; parent=os.path.dirname(base); b=os.lstat(base); assert all(stat.S_ISDIR(os.lstat(d).st_mode) and not stat.S_ISLNK(os.lstat(d).st_mode) and os.lstat(d).st_uid==0 and not(os.lstat(d).st_mode&0o022) for d in ["/","/etc",parent]); assert stat.S_ISDIR(b.st_mode) and not stat.S_ISLNK(b.st_mode) and b.st_uid==0 and (b.st_mode&0o777)==0o700 and os.path.realpath(base)==base; path=os.path.join(base,image[7:]+".sha256"); fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and (s.st_mode&0o777)==0o600 and s.st_nlink==1; value=os.read(fd,80); os.close(fd); assert value==(image+"\n").encode("ascii")' "$1" || { echo 'Independently trusted image ID is not registered.' >&2; return 1; }
}
trusted_image "$candidate"
# A different entrypoint or command can bypass the verified application entirely.
docker image inspect "$candidate" --format '{{json .Config}}' | /usr/bin/python3 -I -c 'import json,sys; c=json.load(sys.stdin); assert c.get("Entrypoint") in (None,[]) and c.get("Cmd")==["node","bridge.mjs"] and c.get("WorkingDir")=="/opt/portal"; assert sorted(c.get("Env",[]))==sorted(["HOME=/var/lib/ssh-mcp","PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"])'
BRIDGE_IMAGE="$candidate" "${compose[@]}" config --format json | /usr/bin/python3 -I -c 'import json,sys; c=json.load(sys.stdin)["services"]["bridge"]; assert c.get("entrypoint") in (None,[]) and c.get("command") in (None,[]) and c.get("working_dir") in (None,"/opt/portal") and c.get("read_only") is True; assert c.get("environment")=={"HOME":"/var/lib/ssh-mcp","BRIDGE_SECRET_ENV_FILE":"/run/secrets/bridge_config"}; roots=[".ssh",".config/ssh-mcp",".local/share/ssh-mcp","transfers"]; expected={"/var/lib/ssh-mcp/"+x for x in roots}; volumes=c.get("volumes",[]); assert len(volumes)==len(expected) and {v.get("target") for v in volumes}==expected and all(v.get("type")=="bind" and v.get("source")==v.get("target") for v in volumes)'
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
env -i PATH=/usr/bin:/bin "$verify_node" "$source_dir/scripts/verify.mjs" "$probe_dir"
cleanup_probe
trap - EXIT
probe=(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --tmpfs /tmp:rw,noexec,nosuid,size=64m)
# Exercise the candidate's reservation and restart contracts in an isolated filesystem.
"${probe[@]}" --entrypoint node "$candidate" --test test/maintenance-durable.test.mjs test/preservation-integration.test.mjs
exec 9>/var/lib/ssh-mcp/.portal-install.lock
flock -n 9 || { echo 'An installation is already in progress.' >&2; exit 1; }
old_container=$("${compose[@]}" ps -q bridge)
[[ -n "$old_container" ]] || { echo 'A running durable bridge is required; legacy and offline updates are unsupported.' >&2; exit 1; }
docker inspect "$old_container" --format '{{json .Mounts}}' | /usr/bin/python3 -I -c 'import json,sys; roots=[".ssh",".config/ssh-mcp",".local/share/ssh-mcp","transfers"]; expected={"/var/lib/ssh-mcp/"+x for x in roots}; all_mounts=json.load(sys.stdin); assert len(all_mounts)==len(expected)+1; mounts=[m for m in all_mounts if m.get("Destination") in expected]; assert len(mounts)==len(expected) and {m.get("Destination") for m in mounts}==expected and all(m.get("Type")=="bind" and m.get("Source")==m.get("Destination") for m in mounts); secrets=[m for m in all_mounts if m.get("Destination")=="/run/secrets/bridge_config"]; assert len(secrets)==1 and secrets[0].get("Type")=="bind" and secrets[0].get("Source")=="/etc/ssh-approval-portal/docker-secrets.env" and not secrets[0].get("RW")'
docker inspect "$old_container" --format '{{json .HostConfig.Tmpfs}}' | /usr/bin/python3 -I -c 'import json,sys; assert set((json.load(sys.stdin) or {}).keys())=={"/tmp"}'
docker inspect "$old_container" --format '{{json .HostConfig}}' | /usr/bin/python3 -I -c 'import json,sys; c=json.load(sys.stdin); assert c.get("ReadonlyRootfs") is True and c.get("Privileged") is False'
docker inspect "$old_container" --format '{{json .Config}}' | /usr/bin/python3 -I -c 'import json,sys; c=json.load(sys.stdin); assert c.get("Entrypoint") in (None,[]) and c.get("Cmd")==["node","bridge.mjs"] and c.get("WorkingDir")=="/opt/portal"'
docker inspect "$old_container" --format '{{json .Config.Env}}' | /usr/bin/python3 -I -c 'import json,sys; expected=["HOME=/var/lib/ssh-mcp","PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","BRIDGE_SECRET_ENV_FILE=/run/secrets/bridge_config"]; assert sorted(json.load(sys.stdin))==sorted(expected)'
candidate_user=$(BRIDGE_IMAGE="$candidate" "${compose[@]}" config --format json | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["services"]["bridge"]["user"])')
[[ $(docker inspect "$old_container" --format '{{.Config.User}}') == "$candidate_user" ]] || { echo 'Bridge user changed; update requires a separate procedure.' >&2; exit 1; }
old_image=$(docker inspect "$old_container" --format '{{.Image}}')
[[ "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Running image is not identifiable.' >&2; exit 1; }
trusted_image "$old_image"
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
[[ $(env_fingerprint) == "$before_env" ]] || { echo 'Compose configuration changed; maintenance retained.' >&2; exit 1; }
/usr/bin/python3 -I "$source_dir/scripts/compose-env.py" image "$env_file" "$candidate" || { echo 'Image configuration update failed; maintenance retained.' >&2; exit 1; }
maintenance release || { echo 'Maintenance release failed or is unknown; retain owner for recovery.' >&2; exit 1; }
maintenance_forget_owner
echo "Compose update verified: $candidate; previous image: $old_image"
