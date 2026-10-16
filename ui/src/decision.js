const reasons = {
  command_set: ['사전 승인 명령셋에 일치', 'Matched the preapproved command set'],
  model_passed: ['위험 평가 기준 통과', 'Risk assessment passed'],
  model_review: ['평가 결과에 따른 사용자 확인 필요', 'Assessment requires owner review'],
  observation_only: ['관측 단계 — 사용자 승인 필요', 'Observation mode — owner approval required'],
  policy_denied: ['서버 정책에서 금지됨', 'Denied by server policy'],
  policy_changed: ['정책 변경으로 사용자 확인 필요', 'Policy changed — owner review required'],
  disclosure_not_enabled: ['외부 평가 미설정 — 사용자 승인 필요', 'External assessment disabled — owner approval required'],
  sensitive_input: ['민감한 입력 — 사용자 확인 필요', 'Sensitive input — owner review required'],
  evaluation_unavailable: ['평가 불가 — 사용자 승인 필요', 'Assessment unavailable — owner approval required'],
  evaluation_failed: ['평가 처리 실패 — 사용자 확인 필요', 'Assessment failed — owner review required'],
  execution_busy: ['자동 실행 보류 — 사용자 확인 필요', 'Automatic dispatch deferred — owner review required'],
  budget_exhausted: ['평가 한도 도달 — 사용자 승인 필요', 'Assessment limit reached — owner approval required'],
};
export function decisionText(decision, korean) {
  const reason = reasons[decision.reasonCode]?.[korean ? 0 : 1] ?? (korean ? '사용자 확인 필요' : 'Owner review required');
  return `${reason}${decision.assessment ? ` · ${decision.provider}: P(low_risk)=${decision.assessment.probabilities.low_risk} · confidence=${decision.assessment.confidence}` : ''}`;
}
