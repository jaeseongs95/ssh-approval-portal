#!/usr/bin/env bash
# Run the same public regression oracles against the pre-fix implementation.
set -euo pipefail
base=2ccec18aac05806af87ade2ba41544042c15a48a
root=$PWD
red=$(mktemp -d "${RUNNER_TEMP:?}/ssh-recovery-red.XXXXXX")
trap 'rm -rf -- "$red"' EXIT
git fetch --no-tags --depth=1 origin "$base"
git archive HEAD | tar -x -C "$red"
ln -s "$root/node_modules" "$red/node_modules"
for file in src/adapters/ssh/vendor.mjs src/adapters/storage/command-output.mjs src/domain/approval-queue.mjs src/application/commands.mjs src/adapters/presentation/results.mjs src/adapters/audit/jsonl.mjs; do
  git show "$base:$file" > "$red/$file"
done
for case in connection accounting diagnostic; do
  case "$case" in
    connection) file=ssh-connection-lifecycle.test.mjs; pattern='SSH-RECOVER command:' ;;
    accounting) file=command-output-accounting.test.mjs; pattern='more than eight failed reservations' ;;
    diagnostic) file=execution-failure.test.mjs; pattern='tagged execution causes survive' ;;
  esac
  log="$RUNNER_TEMP/ssh-recovery-red-$case.log"
  if (cd "$red" && node --test --test-reporter=tap --test-name-pattern="$pattern" "test/$file") > "$log" 2>&1; then
    cat "$log"
    echo "Pre-fix $case regression unexpectedly passed" >&2
    exit 1
  fi
  cat "$log"
  # An import/setup failure is not evidence that the actual regression was caught.
  if grep -Eq 'ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find module' "$log"; then exit 1; fi
  grep -Eq 'AssertionError|ERR_ASSERTION|SSH exec error|Output storage capacity unavailable before dispatch' "$log"
done
