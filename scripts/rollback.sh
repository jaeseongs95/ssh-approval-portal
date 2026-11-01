#!/usr/bin/env bash
# No release-only rollback may reopen an older database generation.
set -euo pipefail
echo 'Legacy rollback is unsupported. Use portal.py deploy status JOB_ID and portal.py deploy resume JOB_ID; automatic replay or database restoration is not performed.' >&2
exit 1
