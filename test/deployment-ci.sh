#!/usr/bin/env bash
# 실제 설치는 폐기 가능한 GitHub Ubuntu VM에서만 실행한다.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == Linux ]] || {
  echo '이 시험은 GitHub Actions Linux 가상머신에서만 실행합니다.' >&2
  exit 2
}
mode=${1:?fresh 또는 legacy-1.7.0 필요}
case "$mode" in fresh|legacy-1.7.0) ;; *) exit 2 ;; esac
results=${DEPLOYMENT_RESULTS:?결과 경로 필요}
mkdir -p "$results"
printf '{"state":"NOT_RUN","reason":"시험 진입 전"}\n' > "$results/result.json"
sudo env GITHUB_ACTIONS=true RUNNER_OS=Linux \
  python3 -I -B "$GITHUB_WORKSPACE/test/deployment-system-fixture.py" \
  --source "$GITHUB_WORKSPACE" --mode "$mode" --results "$results" \
  --candidate "$GITHUB_SHA"
