#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST' >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]+$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
# Existing images may not restore durable ownership after replacement or rollback.
echo 'Compose update is temporarily unavailable: durable maintenance ownership across image replacement has not been verified. Use an independently reviewed offline procedure.' >&2
exit 1
