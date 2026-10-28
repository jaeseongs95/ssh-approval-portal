import { safetyFailureDetails } from '../domain/safety.mjs';
import { commandLineNames } from '../domain/command-line.mjs';
import { inspectCommand, commandDigest, validatedRisk, deniedCommand, explicitUserApproval, AUTOMATION_QUESTION_VERSION, AUTOMATION_QUESTION, AUTOMATION_PROMPT_REVISION, AUTOMATION_PROMPT_SHA256, SAFETY_PROBABILITY_BASIS } from '../domain/command-policy.mjs';
import { assessmentContext, callerContext, sensitiveText } from '../domain/execution-context.mjs';

/** Owner-recorded approval is evaluator input; execution authority remains a separate port. */
export function createCommandAutomation({ queue, state, definition, classify, evaluators, audit, prepareSource, sourceBudget = { bytes: 0, count: 0 }, maxCalls = 100, budget = { used: 0 }, now = () => Date.now() }) {
  const tasks = new Map();
  const sources = new Map();
  const sourcePlan = id => {
    const job = queue.get(id), plan = sources.get(id);
    if (!job || !['pending', 'evaluating', 'running'].includes(job.state) || !plan || job.operation.sourcePlanDigest !== plan.planDigest) throw Error('Source unavailable; never reconstruct or replay');
    return plan;
  };
  const sourceDenied = (plan, rule) => deniedCommand(plan.command + '\n' + plan.stdin + '\n' + plan.manifest.argvJson, rule);
  const sourceReview = rule => rule?.sourceExecutionContract !== 'python-source-v1' ? 'source_execution_not_enabled'
    : rule.automaticSudo !== true ? 'source_privilege_policy_review'
    : rule.deniedCommands.length ? 'source_command_policy_review' : undefined;
  const ruleFor = policy => policy.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === definition.writeProfile);
  queue.beforeCommandStart = job => {
    definition.verify();
    const policy = state.policy();
    if (!ruleFor(policy)?.testServer && deniedCommand(job.command, ruleFor(policy))) throw Error('Command denied by current policy');
    if (job.decision?.decision === 'execute' && policy.revision !== job.decision.policyRevision) throw Error('Command policy changed');
    if (job.operation.sourceContract) {
      const plan = sourcePlan(job.id), rule = ruleFor(policy);
      if (!rule?.testServer && sourceDenied(plan, rule)) throw Error('Source denied by current policy');
      if (!rule?.testServer && job.decision?.decision === 'execute' && sourceReview(rule)) throw Error('Source policy changed');
    }
  };
  const decision = (job, data) => {
    queue.setDecision(job.id, data);
    audit({ action: 'command-decision', id: job.id, decision: data });
  };
  async function assess(command, rule, context, policyRevision, plan) {
    if (!rule?.externalDisclosure) return { reasonCode: 'disclosure_not_enabled' };
    if (!context.trim()) return { reasonCode: 'context_required', evaluation: { purpose: 'execution', callerContextProvided: false, modelCalled: false } };
    if (inspectCommand(command, classify).sensitive) return { reasonCode: 'sensitive_input' };
    let detailedContext;
    try { detailedContext = assessmentContext(context, { targetId: definition.id, targetDisplayName: definition.displayName,
        targetRevision: definition.revision, profile: definition.writeProfile, sshTarget: definition.target,
        commandClass: classify(command).class, policyRevision, externalDisclosure: rule.externalDisclosure,
        modelExecution: rule.modelExecution, fallback: rule.fallback }, undefined, plan); }
    catch (error) { if (plan) return { reasonCode: 'source_evidence_too_large' }; throw error; }
    const approved = plan ? [] : [...rule.commands.filter(name => name !== 'sudo'), ...(rule.automaticSudo === true ? ['sudo'] : [])];
    const input = { command, target: definition.id, environment: definition.displayName, context: detailedContext,
      preapprovedCommands: approved, userApproval: explicitUserApproval(command, approved) };
    const attempts = [];
    let evaluation;
    const provenance = () => evaluation ? { evaluation: { ...evaluation, latencyMs: Math.max(0, now() - evaluation.assessedAt) } } : {};
    for (const provider of ['jev', ...(rule.fallback ? [rule.fallback] : [])]) {
      const configured = evaluators[provider];
      const evaluator = provider === 'jev' && configured?.forModel ? configured.forModel(rule.thresholds.jev?.model) : configured;
      if (!evaluator || evaluator.questionVersion !== AUTOMATION_QUESTION_VERSION) { attempts.push({ provider, status: 'unavailable', reason: 'not_configured' }); continue; }
      if (budget.used >= maxCalls) return { reasonCode: 'budget_exhausted', attempts, ...provenance() };
      let raw, timer, stale = false, exhausted = false;
      const startedAt = now();
      const controller = new AbortController();
      try { raw = await Promise.race([Promise.resolve().then(() => {
          // Re-check inside the invocation microtask: a previous provider can
          // settle after the owner revoked consent or changed the target.
          try {
            definition.verify();
            const current = state.policy(), currentRule = ruleFor(current);
            if (current.revision !== policyRevision || !currentRule?.externalDisclosure || (plan && sourceReview(currentRule))) throw Error('Evaluation consent changed');
          } catch { stale = true; return null; }
          if (budget.used >= maxCalls) { exhausted = true; return null; }
          budget.used++;
          evaluation = { purpose: 'execution', promptRevision: AUTOMATION_PROMPT_REVISION, promptSha256: AUTOMATION_PROMPT_SHA256, assessedAt: startedAt, callerContextProvided: Boolean(context), modelCalled: true };
          return evaluator.assess(structuredClone(input), { signal: controller.signal, question: AUTOMATION_QUESTION, questionVersion: AUTOMATION_QUESTION_VERSION });
        }),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'unavailable', reason: 'timeout' }); }, 10000); })]); }
      catch { raw = { status: 'unavailable', reason: 'request_failed' }; } finally { clearTimeout(timer); }
      if (stale) return { reasonCode: 'policy_changed', attempts, ...provenance() };
      if (exhausted) return { reasonCode: 'budget_exhausted', attempts, ...provenance() };
      const assessment = validatedRisk(raw, evaluator.model);
      if (!assessment) {
        const { reason: failureReason, ...details } = safetyFailureDetails(raw);
        attempts.push({ provider, status: 'unavailable', reason: 'evaluation_failed', failureReason, ...details }); continue;
      }
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
        ...provenance(),
        provider, assessment, attempts, questionVersion: AUTOMATION_QUESTION_VERSION,
        ...(threshold ? { threshold: structuredClone(threshold) } : {}) };
    }
    return { reasonCode: 'evaluation_unavailable', attempts, ...provenance() };
  }
  function run(command, requestKey, context = '', displayContext = '', plan) {
      context = callerContext(context); displayContext = callerContext(displayContext);
      if (requestKey !== undefined && !/^[A-Za-z0-9_.:-]{16,128}$/.test(requestKey)) throw Error('Invalid request key');
      definition.verify();
      const digest = commandDigest(plan ? { sourceContract: plan.manifest.contract, planDigest: plan.planDigest } : command, definition.revision, definition.writeProfile, context, displayContext);
      if (requestKey) {
        const found = state.find(requestKey);
        if (found) {
          if (found.digest !== digest) throw Error('Request key conflict');
          return Promise.resolve({ type: 'job', job: queue.get(found.job.id) ?? found.job });
        }
      }
      const policy = state.policy(), rule = ruleFor(policy);
      if (plan) queue.reap();
      if (plan && (sourceBudget.count >= 100 || sourceBudget.bytes + plan.manifest.sourceBytes > 1024 * 1024)) throw Error('Source memory limit reached');
      const operation = plan && { kind: 'command', command, sourceContract: plan.manifest.contract, sourcePlanDigest: plan.planDigest,
        sourceSha256: plan.manifest.sourceSha256, sourceBytes: plan.manifest.sourceBytes, sourceArgvJson: plan.manifest.argvJson,
        sourceCwd: plan.manifest.cwd, sourceElevate: plan.manifest.elevate, sourceEnvironmentRevision: plan.manifest.environmentRevision,
        ...(context ? { context } : {}), ...(displayContext ? { displayContext } : {}) };
      const job = plan ? queue.submitOperation(operation, 'privileged') : queue.submit(command, false, context, displayContext);
      if (plan) { sources.set(job.id, plan); sourceBudget.bytes += plan.manifest.sourceBytes; sourceBudget.count++; }
      queue.beginEvaluation(job.id);
      try { state.insert(queue.get(job.id), requestKey, digest); } catch (error) { queue.abortEvaluation(job.id); throw error; }
      const persist = value => state.save(value);
      queue.track(job.id, persist);
      const task = (async () => {
        const line = commandLineNames(command);
        const base = { policyRevision: policy.revision, targetRevision: definition.revision };
        let result;
        if (!rule?.testServer && (plan ? sourceDenied(plan, rule) : deniedCommand(command, rule))) {
          decision(job, { ...base, decision: 'deny', reasonCode: 'policy_denied' }); queue.finishEvaluation(job.id, 'denied');
          return;
        }
        if (rule?.testServer === true) result = { reasonCode: 'test_server_bypass' };
        else if (plan && sourceReview(rule)) result = { reasonCode: sourceReview(rule) };
        else if (!plan && line.usesSudo && rule?.automaticSudo !== true) result = { reasonCode: 'sudo_not_enabled' };
        else if (!plan && line.complete && rule && line.names.every(name => name === 'sudo' ? rule.automaticSudo === true : rule.commands.includes(name))) result = { reasonCode: 'command_set', commandNames: line.names };
        else result = await assess(command, rule, context, policy.revision, plan);
        // No await between freshness check, decision record and execution claim.
        definition.verify();
        if (state.policy().revision !== policy.revision) result = { ...result, reasonCode: 'policy_changed' };
        const current = queue.get(job.id);
        if (current.state !== 'evaluating') return;
        const automatic = ['command_set', 'model_passed', 'test_server_bypass'].includes(result.reasonCode);
        decision(job, { ...base, ...result, decision: automatic ? 'execute' : 'review' });
        queue.finishEvaluation(job.id);
        if (automatic) queue.startCommand(job.id);
      })().catch(() => {
        if (queue.get(job.id)?.state === 'evaluating') {
          try { decision(job, { ...queue.get(job.id)?.decision, policyRevision: policy.revision, decision: 'review', reasonCode: 'evaluation_failed' }); queue.finishEvaluation(job.id); }
          catch { queue.abortEvaluation(job.id); }
        } else if (queue.get(job.id)?.state === 'pending') {
          if (queue.rejectAutomaticDispatch(job.id)) return;
          try { decision(job, { ...queue.get(job.id)?.decision, policyRevision: policy.revision, decision: 'review', reasonCode: 'execution_busy' }); } catch { queue.abortEvaluation(job.id); }
        }
      }).finally(() => tasks.delete(job.id));
      tasks.set(job.id, task);
      return Promise.resolve({ type: 'job', job: queue.get(job.id) });
  }
  return {
    run,
    runSource({ source, argv, cwd, elevate, requestKey, context, displayContext }) {
      if (!prepareSource) throw Error('Source execution unavailable');
      if (sensitiveText(source) || sensitiveText(JSON.stringify(argv ?? [])) || sensitiveText(cwd)) throw Error('Sensitive source input refused');
      definition.verify();
      const plan = prepareSource({ source, argv, cwd, elevate, targetId: definition.id, targetRevision: definition.revision, profile: definition.writeProfile });
      return run(plan.command, requestKey, context, displayContext, plan);
    },
    sourcePlan,
    source(id) {
      definition.verify();
      if (queue.get(id)?.state !== 'pending') throw Error('Select a pending source request');
      const plan = sourcePlan(id);
      return { source: plan.stdin, manifest: { ...plan.manifest }, planDigest: plan.planDigest };
    },
    onTerminal(job) {
      const plan = sources.get(job.id);
      if (plan) { sources.delete(job.id); sourceBudget.bytes -= plan.manifest.sourceBytes; sourceBudget.count--; }
    },
    close() { for (const id of sources.keys()) this.onTerminal({ id }); },
    busy: () => tasks.size > 0,
    drain: () => Promise.all([...tasks.values()]),
  };
}
