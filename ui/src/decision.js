const reasons = {
  command_set: ['사전 승인 명령셋에 일치', 'Matched the preapproved command set'],
  upload_policy: ['사용자가 허용한 파일 자동업로드', 'File upload allowed by owner policy'],
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
const reviewReasons = {
  execution_disabled: ['Jev 자동승인이 꺼져 있어 사용자 승인이 필요합니다.', 'Model execution is disabled; owner approval is required.'],
  threshold_missing: ['자동승인 기준이 등록되지 않아 사용자 승인이 필요합니다.', 'No execution threshold is configured; owner approval is required.'],
  model_mismatch: ['설정된 모델과 평가 모델이 달라 자동승인하지 않았습니다.', 'The assessment model differs from the configured model.'],
  question_mismatch: ['평가 방식이 저장된 기준과 달라 자동승인하지 않았습니다.', 'The assessment question differs from the configured threshold.'],
  basis_mismatch: ['점수 방식이 저장된 기준과 달라 자동승인하지 않았습니다.', 'The score basis differs from the configured threshold.'],
  high_risk: ['위험도가 높다는 평가로 사용자 확인이 필요합니다.', 'The assessment is high risk; owner review is required.'],
  uncertain: ['안전 여부를 판단하지 못해 사용자 확인이 필요합니다.', 'The assessment is uncertain; owner review is required.'],
  below_threshold: ['낮은 위험 점수가 자동승인 기준에 못 미쳐 사용자 확인이 필요합니다.', 'The low-risk score is below the execution threshold.'],
};
const labels = { low_risk: ['낮은 위험', 'Low risk'], high_risk: ['높은 위험', 'High risk'], uncertain: ['판단 불가', 'Uncertain'] };
export function decisionText(decision, korean) {
  if (decision.decisionRuleVersion === 'command-explanation-v1' && reviewReasons[decision.reviewReason]) {
    const label = labels[decision.assessment?.label]?.[korean ? 0 : 1];
    return reviewReasons[decision.reviewReason][korean ? 0 : 1] + (label && !['high_risk', 'uncertain'].includes(decision.reviewReason) ? (korean ? ' · AI 분류: ' : ' · AI classification: ') + label : '');
  }
  const reason = reasons[decision.reasonCode]?.[korean ? 0 : 1] ?? (korean ? '사용자 확인 필요' : 'Owner review required');
  const label = labels[decision.assessment?.label]?.[korean ? 0 : 1];
  return `${reason}${label ? (korean ? ' · AI 분류: ' : ' · AI classification: ') + label : ''}`;
}

/** Explain recorded facts, never an invented model rationale. Shared card/web view. */
export function renderDecision(document, parent, decision, korean) {
  const add = (parent, tag, value) => { const node = document.createElement(tag); node.textContent = value; parent.append(node); return node; };
  add(parent, 'p', decisionText(decision, korean));
  const assessment = decision.assessment;
  if (!assessment) return;
  const details = add(parent, 'details', ''); details.className = 'assessment-details';
  add(details, 'summary', korean ? 'AI 평가 상세' : 'AI assessment details');
  add(details, 'p', korean ? '분류 점수는 실제 사고 확률이 아닙니다. 이 응답에는 구체적인 위험 사유가 제공되지 않았습니다.' : 'Classification scores are not incident probabilities. This response provides no specific risk rationale.');
  for (const [key, label] of Object.entries(labels)) if (Number.isFinite(assessment.probabilities?.[key])) add(details, 'p', `${label[korean ? 0 : 1]}: ${(assessment.probabilities[key] * 100).toFixed(1)}%`);
  add(details, 'p', `${decision.provider ?? 'AI'} · ${assessment.model ?? ''}`);
  if (decision.threshold) add(details, 'p', (korean ? '저장된 자동승인 기준: ' : 'Stored execution threshold: ') + (decision.threshold.minLowRisk * 100).toFixed(1) + '%');
  if (Number.isFinite(assessment.confidence)) add(details, 'p', `confidence: ${assessment.confidence} · ` + (korean ? (decision.provider === 'jev' ? '분류 점수 분포에서 계산한 참고값이며 정답률이 아닙니다. 별도 실행 조건으로 사용하지 않습니다.' : '참고값이며 별도 실행 조건으로 사용하지 않습니다.') : 'Diagnostic value, not a separate execution condition.'));
  if (decision.evaluation) add(details, 'p', (korean ? '평가 입력에 저장된 작업 설명: ' : 'Stored caller context: ') + (decision.evaluation.callerContextProvided ? (korean ? '있음' : 'provided') : (korean ? '없음' : 'absent')));
  if (decision.decisionRuleVersion) add(details, 'p', decision.decisionRuleVersion);
}
