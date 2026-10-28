import risks from '../domain/command-risks.json' with { type: 'json' };
import { hash } from '../domain/validation.mjs';
import { validateCommandPolicy, validatedRisk, COMMAND_SET_QUESTION_VERSION } from '../domain/command-policy.mjs';
import { assessmentContext } from '../domain/execution-context.mjs';
import { SAFETY_PROTOCOL, safetyFailureDetails } from '../domain/safety.mjs';
// Validated policy JSON: ignore object key order only; preserve arrays and optional fields.
const ruleJSON = rule => JSON.stringify(rule, (_, value) => value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
const sameRule = (left, right) => ruleJSON(left) === ruleJSON(right);

/** A review is a short-lived, single-use confirmation of the exact policy and revision. */
export function createCommandPolicyReview({ state, validateTargets, evaluator, audit, nonce, maxCalls, budget, now = () => Date.now() }) {
  const reviews = new Map();
  let reviewing = false;
  const checked = (value, revision) => {
    const policy = validateCommandPolicy(value);
    const current = state.policy();
    if (current.revision !== revision) throw Error('Policy revision conflict');
    // Preserve unchanged historical rules without rebinding or granting new authority.
    validateTargets({ targets: policy.targets.filter(rule => !sameRule(current.targets.find(item => item.targetId === rule.targetId), rule)) });
    return policy;
  };
  const sweep = () => { for (const [token, review] of reviews) if (review.expiresAt <= now()) reviews.delete(token); };
  return {
    async review(value, expectedRevision) {
      const policy = checked(value, expectedRevision);
      sweep();
      if (reviewing || reviews.size >= 16) throw Error('Policy review busy');
      reviewing = true;
      try {
        const current = state.policy(), feedback = [];
        for (const rule of policy.targets) {
          if (sameRule(current.targets.find(item => item.targetId === rule.targetId), rule)) continue;
          checked(policy, expectedRevision);
          let assessment, evaluation, failure, reason = 'external_disclosure_not_enabled';
          const commandRisks = rule.commands.filter(name => name !== 'sudo').map(name => ({ name, ...(risks.commands[name] ?? risks.defaultRisk) }));
          const powerful = commandRisks.filter(item => item.riskLevel === 'high').map(item => item.name);
          const selected = evaluator?.forModel ? evaluator.forModel(rule.thresholds.jev?.model) : evaluator;
          if (rule.testServer === true) reason = 'test_server_bypass';
          else if (rule.externalDisclosure && selected && budget.used < maxCalls) {
            budget.used++;
            let timer;
            const startedAt = now();
            const controller = new AbortController();
            try {
              const input = { command: 'Review proposed command-name registration', target: rule.targetId,
                environment: 'SSH command policy', context: assessmentContext('The user is reviewing proposed command names before registration. Names are not yet approved; arguments will have no name-policy restrictions. No command is executed by this review.'
                  + (rule.automaticUploads === true ? ' The proposal also enables user-authorized automatic uploads of new files using the SSH account permissions, without overwrite or sudo. Upload paths, contents and consequences are not known at policy registration; consider later execution, sensitive paths and storage exhaustion.' : '')
                  + (rule.sourceExecutionContract ? ' The proposal enables python-source-v1: disclose caller-submitted full code and arguments to the configured evaluators and, only if execution policy passes, run the exact bound code with an explicit cwd and optional sudo. Command-name preapproval never bypasses code assessment. Runtime/dependencies/files are not attested and the code is not sandboxed. Automatic source execution is withheld when automaticSudo is disabled or denied command names exist; do not change those settings implicitly.' : '')
                  + (rule.automaticDownloads === true ? ' The proposal enables automatic downloads of regular files readable by the SSH account. Contents may contain credentials or private data; Jev does not inspect files. Elevated downloads additionally require automaticSudo and may read root-owned secrets.' : ''),
                  { targetId: rule.targetId, targetRevision: rule.targetRevision, profile: rule.profile,
                    policyRevision: expectedRevision, externalDisclosure: rule.externalDisclosure,
                    modelExecution: rule.modelExecution, fallback: rule.fallback }, 'Give risk feedback for the exact proposed policy before the user can acknowledge and register it'), proposedCommands: [...rule.commands] };
              const raw = await Promise.race([Promise.resolve().then(() => selected.assess(input, { signal: controller.signal })),
                new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unavailable', reason: 'timeout' }), 10000); })]);
              assessment = validatedRisk(raw, selected.model ?? SAFETY_PROTOCOL.model);
              if (!assessment) failure = safetyFailureDetails(raw);
            } catch { failure = { reason: 'request_failed' }; /* Unavailable feedback is never a safety claim. */ }
            finally { clearTimeout(timer); controller.abort(); }
            reason = assessment ? 'assessed' : 'evaluation_unavailable';
            evaluation = { purpose: 'registration', assessedAt: startedAt, latencyMs: Math.max(0, now() - startedAt) };
          } else if (rule.externalDisclosure) reason = selected ? 'budget_exhausted' : 'not_configured';
          feedback.push({ targetId: rule.targetId, commands: [...rule.commands], commandRisks, assessment: assessment ?? null, reason, ...(evaluation ? { evaluation } : {}), ...(failure ? { failure } : {}),
            level: rule.testServer === true || powerful.length || rule.sourceExecutionContract || rule.automaticUploads === true || rule.automaticDownloads === true || rule.automaticSudo === true ? 'high_risk' : assessment?.label ?? 'uncertain',
            warning: (rule.testServer === true ? '테스트 서버 모드입니다. 이 서버의 명령·Python 코드·파일 전송은 금지 명령, sudo 및 개별 허용 설정과 관계없이 위험 심사와 개별 승인을 건너뜁니다. 테스트 서버 지정은 관리자가 판단합니다. ' : '') + (rule.sourceExecutionContract ? '제출한 Python 코드 원문과 인자를 Jev·설정된 대체 평가자에 전송하고, 평가·실행 정책이 통과하면 같은 코드로 실행합니다. 명령 이름 사전허용으로 평가를 건너뛰지 않습니다. 샌드박스가 아니며 파일·의존성·실행 환경의 실제 상태는 확인하지 않습니다. sudo 자동승인이 꺼져 있거나 금지 명령이 있으면 코드 요청은 개별 승인합니다. 다른 허용 설정이나 점수 기준은 자동으로 바꾸지 않습니다. ' : '')
              + (rule.automaticSudo === true ? 'sudo 자동승인을 켜면 다른 사용자 권한으로 실행할 수 있습니다. 내부 명령까지 모두 사전승인이면 Jev 없이 실행하며, 미등록 명령이 있으면 전체 명령줄을 Jev로 평가합니다. 끄면 sudo 요청은 개별 사용자 승인이 필요합니다. ' : '')
              + (rule.automaticUploads === true ? '파일 자동업로드를 켜면 SSH 계정이 쓸 수 있는 경로에 새 파일을 개별 승인 없이 저장합니다. 파일 내용은 Jev가 검사하지 않습니다. 실행 파일·설정·인증 파일 생성과 저장 공간 사용에 영향을 줄 수 있습니다. 덮어쓰기·sudo 업로드는 계속 개별 승인이 필요합니다. ' : '')
              + (rule.automaticDownloads === true ? '파일 자동다운로드를 켜면 SSH 계정이 읽을 수 있는 일반 파일을 개별 승인 없이 준비합니다. 개인정보·설정·인증 파일도 포함될 수 있으며 파일 내용은 Jev가 검사하지 않습니다. sudo 다운로드는 sudo 자동승인까지 함께 켠 경우에만 자동으로 준비합니다. 준비 완료는 PC 저장이나 에이전트 수신 완료를 뜻하지 않습니다. ' : '')
              + (powerful.length ? `${powerful.join(', ')}에는 상태 변경·권한 상승·임의 실행 또는 외부 전송 기능이 있습니다. ` : '')
              + (rule.commands.includes('sudo') ? 'sudo는 별도 허용 설정으로 관리합니다. 켜져 있고 내부 명령 이름까지 모두 등록됐다면 인자 평가나 Jev 없이 실행할 수 있습니다. ' : '')
              + '명령줄의 모든 명령 이름이 사전승인 목록에 있으면 인자 위험도나 Jev 평가 없이 실행합니다. 명령 이름 승인에는 인자별 제한이 없습니다. 삭제·권한 상승·코드 실행·정보 유출 가능성을 확인하세요. 점수는 실제 안전 확률을 보증하지 않습니다.' });
        }
        checked(policy, expectedRevision);
        const token = nonce(), id = nonce(), expiresAt = now() + 300000;
        audit({ action: 'command-policy-reviewed', id, policyRevision: expectedRevision,
          evaluations: feedback.filter(item => item.evaluation).map(item => ({ targetId: item.targetId, ...item.evaluation, reason: item.reason, ...(item.failure ? { failure: item.failure } : {}),
            ...(item.assessment ? { label: item.assessment.label, ...Object.fromEntries(['inputTokens', 'outputTokens'].filter(key => item.assessment[key] !== undefined).map(key => [key, item.assessment[key]])) } : {}) })) });
        reviews.set(token, { id, digest: hash(JSON.stringify(policy)), expectedRevision, expiresAt });
        return { reviewId: id, reviewToken: token, expiresAt, expectedRevision, questionVersion: COMMAND_SET_QUESTION_VERSION, feedback,
          notice: '등록은 아직 이루어지지 않았습니다. 위험도 피드백을 확인하고 OK 해야 등록됩니다. 기존 명령셋 삭제와 자동 실행·외부 전송·점수 기준 변경도 최종 정책에 포함됩니다.' };
      } finally { reviewing = false; }
    },
    set(value, expectedRevision, reviewToken, acknowledged) {
      const policy = checked(value, expectedRevision);
      sweep();
      const review = reviews.get(reviewToken);
      if (acknowledged !== true || !review || review.expectedRevision !== expectedRevision || review.digest !== hash(JSON.stringify(policy))) throw Error('Review and explicit OK required');
      // No await between revision/target/review checks and the durable commit.
      audit({ action: 'command-policy-change-requested', id: review.id, policyRevision: expectedRevision });
      const result = state.setPolicy(policy, expectedRevision);
      reviews.clear();
      return result;
    },
  };
}
