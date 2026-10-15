#!/usr/bin/env bash
# Source this helper so npm and the Python origin validator use the same Node.
set -euo pipefail
(
  set -euo pipefail
  [[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
  runtime=/opt/ssh-approval/node
  case "$(uname -m)" in x86_64) architecture=x64;; aarch64) architecture=arm64;; *) echo 'Unsupported CPU' >&2; exit 1;; esac
  runtime_stage=
  cleanup() { if [[ -n "$runtime_stage" ]]; then rm -rf -- "$runtime_stage"; fi; }
  trap cleanup EXIT
  if [[ ! -x "$runtime/bin/node" ]]; then
    install -d -m 0755 /opt/ssh-approval
    runtime_stage=$(mktemp -d /opt/ssh-approval/.node-stage.XXXXXXXX)
    node_version=24.21.0
    node_archive=node-v${node_version}-linux-${architecture}.tar.xz
    curl -fsS --proto '=https' "https://nodejs.org/dist/v${node_version}/$node_archive" -o "$runtime_stage/$node_archive"
    curl -fsS --proto '=https' "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$runtime_stage/SHASUMS256.txt"
    (cd "$runtime_stage"; grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$runtime_stage/$node_archive" -C "$runtime_stage"
    mv -- "$runtime_stage/node-v${node_version}-linux-${architecture}" "$runtime"
  fi
  [[ $("$runtime/bin/node" -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo 'Node 24 required' >&2; exit 1; }
)
export PATH="/opt/ssh-approval/node/bin:$PATH"
