import { SAFETY_DIAGNOSTICS } from '../../src/domain/safety.mjs';

export function requestContext(job, korean = true) {
  const operation = job.operation;
  return korean ? operation?.displayContext || operation?.context : operation?.context || operation?.displayContext;
}

const reasons = {
  source_execution_not_enabled: ['제출 코드 평가·실행이 허용되지 않아 사용자 승인이 필요합니다.', 'Submitted code assessment/execution is not enabled; owner approval is required.'],
  source_privilege_policy_review: ['임의 코드의 권한을 이름만으로 제한할 수 없어 현재 sudo 정책에서는 개별 승인합니다.', 'Arbitrary code privileges cannot be constrained by names; this sudo policy requires individual approval.'],
  source_command_policy_review: ['임의 코드 안의 금지 명령 사용을 이름만으로 확인할 수 없어 개별 승인합니다.', 'Denied command use inside arbitrary code cannot be established by name scanning; individual approval is required.'],
  source_evidence_too_large: ['코드와 설명이 평가 입력 한도를 넘어 사용자 확인이 필요합니다. 내용을 잘라 보내지 않았습니다.', 'Source and context exceed the assessment input limit. Nothing was truncated; owner review is required.'],
  sudo_not_enabled: ['sudo 자동승인이 꺼져 있어 개별 사용자 승인이 필요합니다.', 'Automatic sudo is disabled; individual owner approval is required.'],
  context_required: ['작업 설명이 없어 AI 평가를 요청하지 않았습니다. 작업 목적·대상·예상 영향·복구 방법을 확인해 주세요.', 'No AI call was made because task context is missing. Check the purpose, target, expected impact and recovery plan.'],
  command_set: ['사전 승인 명령셋에 일치', 'Matched the preapproved command set'],
  upload_policy: ['사용자가 허용한 파일 자동업로드', 'File upload allowed by owner policy'],
  download_policy: ['사용자가 허용한 파일 자동다운로드', 'File download allowed by owner policy'],
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
const assessmentFailures = {
  not_configured: ['평가자가 설정되지 않았습니다.', 'The evaluator is not configured.'],
  busy: ['다른 평가가 진행 중입니다.', 'Another assessment is in progress.'],
  invalid_input: ['평가 입력 형식을 검증하지 못했습니다.', 'Assessment input validation failed.'],
  input_too_large: ['평가 입력 크기 한도를 초과했습니다.', 'The assessment input exceeds the size limit.'],
  timeout: ['평가 응답 대기 시간을 초과했습니다.', 'The assessment timed out.'],
  http_error: ['평가 서비스가 오류 응답을 반환했습니다.', 'The assessment service returned an HTTP error.'],
  invalid_response: ['평가 응답 형식이 검증을 통과하지 못했습니다.', 'The assessment response format failed validation.'],
  response_too_large: ['평가 응답 크기 한도를 초과했습니다.', 'The assessment response exceeds the size limit.'],
  request_failed: ['평가 요청 또는 응답 처리에 실패했습니다.', 'The assessment request or response processing failed.'],
};

const recordedReasons = {
  execution_disabled: ['Jev 자동승인이 꺼져 있었습니다.', 'Model execution was disabled.'],
  threshold_missing: ['자동승인 기준이 등록되지 않았습니다.', 'No execution threshold was configured.'],
  model_mismatch: ['설정된 모델과 평가 모델이 달랐습니다.', 'The configured and assessment models differed.'],
  question_mismatch: ['평가 방식이 당시 저장된 기준과 달랐습니다.', 'The assessment question differed from the stored threshold.'],
  basis_mismatch: ['점수 방식이 당시 저장된 기준과 달랐습니다.', 'The score basis differed from the stored threshold.'],
  high_risk: ['AI가 위험도가 높다고 분류했습니다.', 'AI classified the request as high risk.'],
  uncertain: ['AI가 위험도를 판단하지 못했습니다.', 'AI could not determine the risk.'],
  below_threshold: ['낮은 위험 점수가 당시 자동승인 기준에 못 미쳤습니다.', 'The low-risk score was below the threshold at the time.'],
};
const labels = { low_risk: ['낮은 위험', 'Low risk'], high_risk: ['높은 위험', 'High risk'], uncertain: ['판단 불가', 'Uncertain'] };
const binaryLabels = { low_risk: ['안전', 'Safe'], high_risk: ['위험', 'Risk'] };
const labelsFor = assessment => assessment?.probabilities && !Object.hasOwn(assessment.probabilities, 'uncertain') ? binaryLabels : labels;
export function decisionText(decision, korean) {
  if (decision.decisionRuleVersion === 'command-explanation-v1' && reviewReasons[decision.reviewReason]) {
    const label = labelsFor(decision.assessment)[decision.assessment?.label]?.[korean ? 0 : 1];
    return reviewReasons[decision.reviewReason][korean ? 0 : 1] + (label && !['high_risk', 'uncertain'].includes(decision.reviewReason) ? (korean ? ' · AI 분류: ' : ' · AI classification: ') + label : '');
  }
  const reason = reasons[decision.reasonCode]?.[korean ? 0 : 1] ?? (korean ? '사유 설명 미지원' : 'Reason description unavailable');
  const label = labelsFor(decision.assessment)[decision.assessment?.label]?.[korean ? 0 : 1];
  return `${reason}${label ? (korean ? ' · AI 분류: ' : ' · AI classification: ') + label : ''}`;
}

/** Admission records an approval route only after a request enters execution. */
export function recordedApprovalMode(job) {
  return ['running', 'completed', 'failed', 'unknown'].includes(job.state) && ['owner', 'automatic'].includes(job.approvalMode) ? job.approvalMode : undefined;
}

/** Explain recorded facts, never an invented model rationale. Shared card/web view. */
export function renderDecision(document, parent, decision, korean, job = {}) {
  const add = (parent, tag, value) => { const node = document.createElement(tag); node.textContent = value; parent.append(node); return node; };
  const box = add(parent, 'div', ''); box.className = 'assessment-summary';
  const approval = recordedApprovalMode(job);
  const historical = ['running', 'completed', 'failed', 'unknown'].includes(job.state);
  const assessment = decision.assessment;
  const titles = {
    pending: ['승인 대기', 'Awaiting approval'], evaluating: ['승인 조건 확인 중', 'Checking approval conditions'],
    denied: ['거절됨', 'Denied'], expired: ['승인 기한 만료', 'Approval expired'],
  };
  const title = approval === 'owner' ? ['사용자가 승인한 요청입니다', 'Approved by the owner']
    : approval === 'automatic' ? ['자동승인', 'Automatically approved']
    : historical ? ['승인 방식 미확인', 'Approval route not recorded']
    : titles[job.state] ?? ['정책 판단 기록', 'Recorded policy decision'];
  add(box, 'strong', title[korean ? 0 : 1]);
  if (approval === 'owner' && assessment) add(box, 'small', korean ? '아래는 사용자 승인 전 AI 검토 결과입니다.' : 'The assessment below was recorded before owner approval.');
  if (historical && decision.decision === 'review') {
    add(box, 'p', approval === 'owner'
      ? (korean ? '당시 자동승인을 보류했고, 사용자가 직접 승인해 진행한 요청입니다.' : 'Automatic approval was withheld at the time; the owner subsequently approved this request.')
      : (korean ? '당시 정책은 사용자 검토로 분류했습니다. 현재 처리 상태와 승인 방식은 별도 기록입니다.' : 'The policy required review at the time. Current processing state and approval route are separate records.'));
  } else if (job.state === 'pending' && decision.decision === 'execute') {
    add(box, 'p', korean ? '자동승인 조건 일치 기록이 있으나 실행 시작은 확인되지 않았습니다.' : 'The policy matched automatic approval conditions, but execution has not started.');
  } else if (historical) {
    add(box, 'p', (korean ? '당시 정책 판단: ' : 'Policy decision at the time: ') + decisionText(decision, korean));
  } else add(box, 'p', decisionText(decision, korean));
  const failures = Array.isArray(decision.attempts) ? decision.attempts.flatMap(attempt => {
    const reason = attempt?.failureReason ?? attempt?.reason;
    if (attempt?.status !== 'unavailable' || typeof reason !== 'string' || !Object.hasOwn(assessmentFailures, reason)) return [];
    return [{ reason, diagnostic: SAFETY_DIAGNOSTICS.includes(attempt.diagnostic) ? attempt.diagnostic : undefined }];
  }) : [];
  if (failures.length) {
    const details = add(parent, 'details', ''); details.className = 'assessment-details assessment-failure-details';
    add(details, 'summary', korean ? 'AI 평가 실패 상세' : 'AI assessment failure details');
    const body = add(details, 'div', ''); body.className = 'assessment-body';
    add(body, 'p', korean ? '평가 요청·응답 처리에서 기록된 실패입니다. 모델의 위험도 분류 사유는 제공하지 않습니다.' : 'These failures were recorded while processing assessment requests or responses. They do not explain a model risk classification.');
    for (const failure of failures) {
      add(body, 'p', assessmentFailures[failure.reason][korean ? 0 : 1]);
      if (failure.diagnostic) add(body, 'small', (korean ? '진단 코드: ' : 'Diagnostic code: ') + failure.diagnostic);
    }
  }
  if (!assessment) return;
  const details = add(parent, 'details', ''); details.className = 'assessment-details';
  add(details, 'summary', korean ? 'AI 평가 상세' : 'AI assessment details');
  const body = add(details, 'div', ''); body.className = 'assessment-body';
  if (historical) add(body, 'p', decision.decision === 'review'
    ? (korean ? '당시 보류 사유: ' : 'Reason withheld at the time: ') + (recordedReasons[decision.reviewReason]?.[korean ? 0 : 1] ?? (korean ? '당시 정책은 사용자 검토로 분류했습니다.' : 'The policy required review at the time.'))
    : (korean ? '당시 정책 판단: ' : 'Policy decision at the time: ') + decisionText(decision, korean));
  add(body, 'p', korean ? '점수는 AI가 어느 분류에 무게를 뒀는지 보여줍니다. 실제 사고 확률이 아닙니다.' : 'These scores show the model’s classification weights, not incident probabilities.');
  const scores = add(body, 'dl', ''); scores.className = 'assessment-scores';
  for (const [key, label] of Object.entries(labelsFor(assessment))) if (Number.isFinite(assessment.probabilities?.[key])) { add(scores, 'dt', label[korean ? 0 : 1]); add(scores, 'dd', `${(assessment.probabilities[key] * 100).toFixed(1)}%`); }
  if (decision.threshold && Number.isFinite(decision.threshold.minLowRisk)) add(body, 'p', (korean ? '평가 당시 자동승인 기준: 낮은 위험으로 분류되고 점수 ' : 'Threshold at assessment: classified low risk with a score of ') + (decision.threshold.minLowRisk * 100).toFixed(1) + (korean ? '% 이상' : '% or higher'));
  if (historical) add(body, 'small', korean ? '과거 평가 당시의 기준과 점수를 표시합니다. 이후 설정 변경은 이 기록에 반영되지 않습니다.' : 'These are the historical threshold and scores; later policy changes do not rewrite this record.');
  add(body, 'p', korean ? '모델은 분류 점수만 반환했고 구체적인 위험 근거는 제공하지 않았습니다. 이 점수만으로 실제 안전 여부를 확정할 수 없습니다.' : 'The model returned classification scores without a specific risk rationale. Scores alone do not establish actual safety.');
  if (decision.evaluation && !decision.evaluation.callerContextProvided) add(body, 'p', korean ? '이 평가에는 요청자의 작업 설명이 포함되지 않았습니다.' : 'This assessment did not include caller-provided task context.');
  if (requestContext(job, korean)) { add(body, 'strong', korean ? '요청에 첨부된 작업 설명' : 'Task context attached to the request'); add(body, 'p', requestContext(job, korean)); }
  add(body, 'small', (korean ? '평가 모델: ' : 'Assessment model: ') + (assessment.model ?? decision.provider ?? 'AI'));
}
