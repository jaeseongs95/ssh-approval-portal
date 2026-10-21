import { safetyFailureDetails, validateAssessment } from '../domain/safety.mjs';
import { assessmentContext, callerContext } from '../domain/execution-context.mjs';

/** Observation only. No execution, decision, or credential ports. Process-local cache. */
export function createRequestSafety({ queue, assessor, maxCalls = 100, now = () => Date.now() }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10000) throw Error('Invalid Jev call budget');
  const observations = new Map();
  let calls = 0;
  return {
    async assess(id, context = '') {
      const job = queue.get(id);
      if (!job || job.kind !== 'command') throw Error('Select a command request');
      // This legacy observation path has no source disclosure grant or private body.
      if (job.operation.sourceContract) throw Error('Use the recorded source evaluation; receiver-only observation is unavailable');
      const situation = [callerContext(job.operation?.context), callerContext(context)].filter(Boolean).join('\n\n');
      const detailedContext = assessmentContext(situation, { targetId: job.targetId ?? 'default',
        targetDisplayName: job.targetDisplayName, targetRevision: job.targetRevision,
        profile: job.profile, sshTarget: job.target, commandClass: job.commandClass, requestState: job.state }, 'Observe risk only; owner approval remains required and no command is executed by this assessment');
      const cached = observations.get(id);
      if (cached) {
        const result = structuredClone(await cached.result);
        result.provenance.cached = true;
        result.provenance.additionalContextApplied = cached.context === detailedContext;
        result.provenance.inputStatus = cached.context === detailedContext ? 'same_input' : 'input_changed_not_reassessed';
        result.provenance.historical = job.state !== result.provenance.requestState;
        return result;
      }
      if (job.state !== 'pending') throw Error('Select a pending command request');
      const subject = queue.subject(id);
      const base = { id, subject, targetId: job.targetId ?? 'default',
        ...(job.targetRevision ? { targetRevision: job.targetRevision } : {}),
        advisory: true, automaticExecutionEnabled: false };
      if (!assessor || calls >= maxCalls) return { ...base,
        assessment: { status: 'unavailable', reason: assessor ? 'budget_exhausted' : 'not_configured' } };
      // Synchronous reservation before any await prevents duplicate calls across
      // independent stateless MCP sessions. Entries live only while their job does.
      for (const key of observations.keys()) if (!queue.jobs.has(key)) observations.delete(key);
      calls++;
      const assessedAt = now();
      const pending = Promise.resolve().then(async () => {
        let result;
        try { result = await assessor.assess({ command: job.command, target: base.targetId,
          environment: job.targetDisplayName || 'SSH target; operating system unspecified',
          context: detailedContext }); }
        catch { result = { status: 'unavailable', reason: 'request_failed' }; }
        const assessment = validateAssessment(result) ?? { status: 'unavailable',
          ...safetyFailureDetails(result) };
        return { ...base, assessment, provenance: { purpose: 'observation', cached: false, assessedAt,
          latencyMs: Math.max(0, now() - assessedAt), requestState: job.state, inputRevision: 1,
          storedContextProvided: Boolean(job.operation?.context), additionalContextApplied: true,
          inputStatus: 'first_assessment', historical: false } };
      });
      observations.set(id, { context: detailedContext, result: pending });
      return structuredClone(await pending);
    },
  };
}
