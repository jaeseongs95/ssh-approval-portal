import { SAFETY_FAILURES, validateAssessment } from '../domain/safety.mjs';

/** Observation only. No execution, decision, or credential ports. Process-local cache. */
export function createRequestSafety({ queue, assessor, maxCalls = 100 }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10000) throw Error('Invalid Jev call budget');
  const observations = new Map();
  let calls = 0;
  return {
    async assess(id, context = '') {
      const job = queue.get(id);
      if (!job || job.kind !== 'command') throw Error('Select a command request');
      const cached = observations.get(id);
      if (cached) return structuredClone(await cached);
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
      const pending = Promise.resolve().then(async () => {
        let result;
        try { result = await assessor.assess({ command: job.command, target: base.targetId,
          environment: job.targetDisplayName || 'SSH target; operating system unspecified',
          context: context || 'No additional context. Effects or sensitivity may be unknown.' }); }
        catch { result = { status: 'unavailable', reason: 'request_failed' }; }
        const assessment = validateAssessment(result) ?? { status: 'unavailable',
          reason: result?.status === 'unavailable' && SAFETY_FAILURES.includes(result.reason) ? result.reason : 'invalid_response' };
        return { ...base, assessment };
      });
      observations.set(id, pending);
      return structuredClone(await pending);
    },
  };
}
