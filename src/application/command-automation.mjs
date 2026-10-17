import { inspectCommand, commandDigest, validatedRisk, deniedCommand, explicitUserApproval, AUTOMATION_QUESTION_VERSION, AUTOMATION_QUESTION, SAFETY_PROBABILITY_BASIS } from '../domain/command-policy.mjs';
import { assessmentContext, callerContext } from '../domain/execution-context.mjs';

/** Owner-recorded approval is evaluator input; execution authority remains a separate port. */
export function createCommandAutomation({ queue, state, definition, classify, evaluators, audit, maxCalls = 100, budget = { used: 0 }, now = () => Date.now() }) {
  const tasks = new Map();
  const ruleFor = policy => policy.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === definition.writeProfile);
  queue.beforeCommandStart = job => {
    definition.verify();
    const policy = state.policy();
    if (deniedCommand(job.command, ruleFor(policy))) throw Error('Command denied by current policy');
    if (job.decision?.decision === 'execute' && policy.revision !== job.decision.policyRevision) throw Error('Command policy changed');
  };
  const decision = (job, data) => {
    queue.setDecision(job.id, data);
    audit({ action: 'command-decision', id: job.id, decision: data });
  };
  async function assess(command, rule, context, policyRevision) {
    if (!rule?.externalDisclosure) return { reasonCode: 'disclosure_not_enabled' };
    if (inspectCommand(command, classify).sensitive) return { reasonCode: 'sensitive_input' };
    const input = { command, target: definition.id, environment: definition.displayName,
      context: assessmentContext(context, { targetId: definition.id, targetDisplayName: definition.displayName,
        targetRevision: definition.revision, profile: definition.writeProfile, sshTarget: definition.target,
        commandClass: classify(command).class, policyRevision, externalDisclosure: rule.externalDisclosure,
        modelExecution: rule.modelExecution, fallback: rule.fallback }),
      preapprovedCommands: [...rule.commands], userApproval: explicitUserApproval(command, rule.commands) };
    const attempts = [];
    for (const provider of ['jev', ...(rule.fallback ? [rule.fallback] : [])]) {
      const evaluator = evaluators[provider];
      if (!evaluator || evaluator.questionVersion !== AUTOMATION_QUESTION_VERSION) { attempts.push({ provider, status: 'unavailable', reason: 'not_configured' }); continue; }
      if (budget.used >= maxCalls) return { reasonCode: 'budget_exhausted', attempts };
      budget.used++;
      let raw, timer;
      const startedAt = now();
      const controller = new AbortController();
      try { raw = await Promise.race([Promise.resolve().then(() => evaluator.assess(structuredClone(input), { signal: controller.signal, question: AUTOMATION_QUESTION, questionVersion: AUTOMATION_QUESTION_VERSION })),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 10000); })]); }
      catch { raw = null; } finally { clearTimeout(timer); }
      const assessment = validatedRisk(raw, evaluator.model);
      if (!assessment) { attempts.push({ provider, status: 'unavailable', reason: 'evaluation_failed' }); continue; }
      // A valid risky/uncertain/low-scoring result is final: never shop for a second opinion.
      const threshold = rule.thresholds[provider];
      const passed = Boolean(rule.modelExecution && threshold && threshold.model === evaluator.model
        && threshold.questionVersion === AUTOMATION_QUESTION_VERSION && threshold.basis === SAFETY_PROBABILITY_BASIS
        && assessment.label === 'low_risk' && assessment.probabilities.low_risk >= threshold.minLowRisk);
      // Explanation only: record the first failed condition of the existing AND gate.
      const reviewReason = !rule.modelExecution ? 'execution_disabled' : !threshold ? 'threshold_missing'
        : threshold.model !== evaluator.model ? 'model_mismatch'
        : threshold.questionVersion !== AUTOMATION_QUESTION_VERSION ? 'question_mismatch'
        : threshold.basis !== SAFETY_PROBABILITY_BASIS ? 'basis_mismatch'
        : assessment.label !== 'low_risk' ? assessment.label
        : assessment.probabilities.low_risk < threshold.minLowRisk ? 'below_threshold' : undefined;
      return { reasonCode: passed ? 'model_passed' : !rule.modelExecution || !threshold ? 'observation_only' : 'model_review',
        ...(reviewReason ? { reviewReason } : {}), decisionRuleVersion: 'command-explanation-v1',
        evaluation: { purpose: 'execution', assessedAt: startedAt, latencyMs: Math.max(0, now() - startedAt), callerContextProvided: Boolean(context) },
        provider, assessment, attempts, questionVersion: AUTOMATION_QUESTION_VERSION,
        ...(threshold ? { threshold: structuredClone(threshold) } : {}) };
    }
    return { reasonCode: 'evaluation_unavailable', attempts };
  }
  return {
    run(command, requestKey, context = '') {
      context = callerContext(context);
      if (requestKey !== undefined && !/^[A-Za-z0-9_.:-]{16,128}$/.test(requestKey)) throw Error('Invalid request key');
      definition.verify();
      const digest = commandDigest(command, definition.revision, definition.writeProfile, context);
      if (requestKey) {
        const found = state.find(requestKey);
        if (found) {
          if (found.digest !== digest) throw Error('Request key conflict');
          return Promise.resolve({ type: 'job', job: queue.get(found.job.id) ?? found.job });
        }
      }
      const job = queue.submit(command, false, context), policy = state.policy(), rule = ruleFor(policy);
      queue.beginEvaluation(job.id);
      try { state.insert(queue.get(job.id), requestKey, digest); } catch (error) { queue.abortEvaluation(job.id); throw error; }
      const persist = value => state.save(value);
      queue.track(job.id, persist);
      const task = (async () => {
        const scan = inspectCommand(command, classify);
        const base = { policyRevision: policy.revision, targetRevision: definition.revision };
        let result;
        if (deniedCommand(command, rule)) {
          decision(job, { ...base, decision: 'deny', reasonCode: 'policy_denied' }); queue.finishEvaluation(job.id, 'denied');
          return;
        }
        if (rule?.commands.includes(scan.executable) && !scan.risky) result = { reasonCode: 'command_set' };
        else result = await assess(command, rule, context, policy.revision);
        // No await between freshness check, decision record and execution claim.
        definition.verify();
        if (state.policy().revision !== policy.revision) result = { reasonCode: 'policy_changed' };
        const current = queue.get(job.id);
        if (current.state !== 'evaluating') return;
        const automatic = ['command_set', 'model_passed'].includes(result.reasonCode);
        decision(job, { ...base, ...result, decision: automatic ? 'execute' : 'review' });
        queue.finishEvaluation(job.id);
        if (automatic) queue.startCommand(job.id);
      })().catch(() => {
        if (queue.get(job.id)?.state === 'evaluating') {
          try { decision(job, { policyRevision: policy.revision, decision: 'review', reasonCode: 'evaluation_failed' }); queue.finishEvaluation(job.id); }
          catch { queue.abortEvaluation(job.id); }
        } else if (queue.get(job.id)?.state === 'pending') {
          try { decision(job, { policyRevision: policy.revision, decision: 'review', reasonCode: 'execution_busy' }); } catch { queue.abortEvaluation(job.id); }
        }
      }).finally(() => tasks.delete(job.id));
      tasks.set(job.id, task);
      return Promise.resolve({ type: 'job', job: queue.get(job.id) });
    },
    busy: () => tasks.size > 0,
    drain: () => Promise.all([...tasks.values()]),
  };
}
