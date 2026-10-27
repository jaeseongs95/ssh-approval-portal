#!/usr/bin/env bash
# Source as root. The retained private file is required for recovery after uncertain outcomes.
maintenance_new_owner() {
  local base=/var/lib/ssh-mcp/.maintenance-owners
  [[ ! -L "$base" ]] || { echo 'Unsafe maintenance owner directory.' >&2; return 1; }
  install -d -m 0700 "$base"
  [[ $(stat -c '%u:%a' "$base") == 0:700 ]] || { echo 'Unsafe maintenance owner directory.' >&2; return 1; }
  maintenance_owner_dir=$(mktemp -d "$base/job.XXXXXXXX")
  maintenance_owner_file=$maintenance_owner_dir/owner
  (umask 077; /usr/bin/python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_hex(32))' > "$maintenance_owner_file")
  echo "Maintenance recovery file: $maintenance_owner_file" >&2
}

maintenance_forget_owner() {
  rm -f -- "$maintenance_owner_file"
  rmdir -- "$maintenance_owner_dir"
}
