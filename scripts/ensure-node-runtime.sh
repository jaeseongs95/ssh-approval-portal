#!/usr/bin/env bash
# Source this helper so npm and the Python origin validator use the same Node.
set -euo pipefail
(
  set -euo pipefail
  [[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
  umask 022
  runtime_check=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/node-runtime.py
  runtime=/opt/ssh-approval/node
  case "$(uname -m)" in x86_64) architecture=x64;; aarch64) architecture=arm64;; *) echo 'Unsupported CPU' >&2; exit 1;; esac
  runtime_stage=
  runtime_backup=
  cleanup() {
    if [[ -n "$runtime_backup" && ! -e "$runtime" && ! -L "$runtime" && -d "$runtime_backup/node" ]]; then mv -- "$runtime_backup/node" "$runtime"; fi
    if [[ -n "$runtime_stage" ]]; then rm -rf -- "$runtime_stage"; fi
  }
  trap cleanup EXIT
  python3 -I -B "$runtime_check" parent /opt/ssh-approval
  install -d -m 0755 /opt/ssh-approval
  [[ ! -L "$runtime" && ( ! -e "$runtime" || -d "$runtime" ) ]] || { echo 'Unexpected Node runtime path' >&2; exit 1; }
  lock=/opt/ssh-approval/.node-runtime.lock
  [[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && $(stat -c '%u:%h:%a' "$lock") == 0:1:600 ) ) ]] || { echo 'Unexpected Node runtime lock' >&2; exit 1; }
  (umask 077; touch -- "$lock")
  exec 8>"$lock"
  flock -n 8 || { echo 'Node runtime installation is already in progress' >&2; exit 1; }
  if ! { python3 -I -B "$runtime_check" runtime "$runtime" 2>/dev/null && [[ $(env -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$runtime/bin/node" -p 'process.versions.node.split(".")[0]') == 24 ]]; }; then
    runtime_stage=$(mktemp -d /opt/ssh-approval/.node-stage.XXXXXXXX)
    node_version=24.21.0
    node_archive=node-v${node_version}-linux-${architecture}.tar.xz
    curl -fsS --proto '=https' "https://nodejs.org/dist/v${node_version}/$node_archive" -o "$runtime_stage/$node_archive"
    curl -fsS --proto '=https' "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$runtime_stage/SHASUMS256.txt"
    (cd "$runtime_stage"; grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
    tar --no-same-owner --no-same-permissions -xJf "$runtime_stage/$node_archive" -C "$runtime_stage"
    candidate=$runtime_stage/node-v${node_version}-linux-${architecture}
    python3 -I -B "$runtime_check" runtime "$candidate"
    [[ $(env -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$candidate/bin/node" -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo 'Node 24 required' >&2; exit 1; }
    if [[ -d "$runtime" ]]; then
      runtime_backup=$(mktemp -d /opt/ssh-approval/.node-previous.XXXXXXXX)
      mv -- "$runtime" "$runtime_backup/node"
    fi
    mv -- "$runtime_stage/node-v${node_version}-linux-${architecture}" "$runtime"
    if [[ -n "$runtime_backup" ]]; then printf 'Previous Node runtime preserved in %s/node\n' "$runtime_backup"; fi
  fi
)
export PATH="/opt/ssh-approval/node/bin:$PATH"
