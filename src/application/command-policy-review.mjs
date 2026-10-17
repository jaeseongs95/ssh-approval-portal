import { hash } from '../domain/validation.mjs';
import { validateCommandPolicy, validatedRisk, COMMAND_SET_QUESTION_VERSION } from '../domain/command-policy.mjs';
import { assessmentContext } from '../domain/execution-context.mjs';

/** A review is a short-lived, single-use confirmation of the exact policy and revision. */
export function createCommandPolicyReview({ state, validateTargets, evaluator, audit, nonce, maxCalls, budget, now = () => Date.now() }) {
  const reviews = new Map();
  let reviewing = false;
  const checked = (value, revision) => {
    const policy = validateCommandPolicy(value);
    if (state.policy().revision !== revision) throw Error('Policy revision conflict');
    validateTargets(policy);
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
          if (JSON.stringify(current.targets.find(item => item.targetId === rule.targetId)) === JSON.stringify(rule)) continue;
          checked(policy, expectedRevision);
          let assessment, reason = 'external_disclosure_not_enabled';
          const powerful = rule.commands.filter(name => /^(su|sh|bash|zsh|python[0-9.]*|node|perl|ruby|rm|rmdir|mv|cp|dd|mkfs(?:\..*)?|chmod|chown|mount|umount|systemctl|reboot|shutdown|kill|pkill|iptables|ufw|curl|wget|scp|sftp|rsync|ssh|nc|find|xargs|env)$/.test(name));
          if (rule.externalDisclosure && evaluator && budget.used < maxCalls) {
            budget.used++;
            let timer;
            const controller = new AbortController();
            try {
              const input = { command: 'Review proposed command-name registration', target: rule.targetId,
                environment: 'SSH command policy', context: assessmentContext('The user is reviewing proposed command names before registration. Names are not yet approved; arguments will have no name-policy restrictions. No command is executed by this review.',
                  { targetId: rule.targetId, targetRevision: rule.targetRevision, profile: rule.profile,
                    policyRevision: expectedRevision, externalDisclosure: rule.externalDisclosure,
                    modelExecution: rule.modelExecution, fallback: rule.fallback }, 'Give risk feedback for the exact proposed policy before the user can acknowledge and register it'), proposedCommands: [...rule.commands] };
              assessment = validatedRisk(await Promise.race([Promise.resolve().then(() => evaluator.assess(input, { signal: controller.signal })),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); })]), 'jev-1.13.0');
            } catch { /* Unavailable feedback is explicitly uncertain, never a safety claim. */ }
            finally { clearTimeout(timer); controller.abort(); }
            reason = assessment ? 'assessed' : 'evaluation_unavailable';
          } else if (rule.externalDisclosure) reason = evaluator ? 'budget_exhausted' : 'not_configured';
          feedback.push({ targetId: rule.targetId, commands: [...rule.commands], assessment: assessment ?? null, reason,
            level: powerful.length ? 'high_risk' : assessment?.label ?? 'uncertain',
            warning: (powerful.length ? `${powerful.join(', ')}에는 상태 변경·권한 상승·임의 실행 또는 외부 전송 기능이 있습니다. ` : '')
              + (rule.commands.includes('sudo') ? 'sudo는 단독으로 위험하다고 판정하지 않으며, 실제 인자를 포함한 동작을 실행 전에 판단합니다. ' : '')
              + '명령 이름 승인에는 인자별 제한이 없습니다. 삭제·권한 상승·코드 실행·정보 유출 가능성을 확인하세요. 점수는 실제 안전 확률을 보증하지 않습니다.' });
        }
        checked(policy, expectedRevision);
        const token = nonce(), id = nonce(), expiresAt = now() + 300000;
        audit({ action: 'command-policy-reviewed', id, policyRevision: expectedRevision });
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
