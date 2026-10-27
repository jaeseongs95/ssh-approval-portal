#!/usr/bin/env bash

# An offline existing installation has no captured baseline or reservation.
require_fresh_installation() {
  local active=$1 unit=$2 env_file=$3
  if [[ -e "$active" || -L "$active" || -e "$unit" || -L "$unit" || -e "$env_file" || -L "$env_file" ]]; then
    echo 'Existing installation is stopped; an independently verified offline transition is required.' >&2
    return 1
  fi
}
