// Keep exception identity private: arbitrary error properties are never diagnostic input.
const failures = new WeakMap();
const reasons = new Set(['unknown', 'maintenance', 'request_state', 'authority', 'invalid_command', 'private_plan', 'target_changed', 'policy_changed', 'policy_denied', 'plan_expired', 'busy', 'claim_failed', 'audit_failed', 'persistence_failed']);
const stages = new Set(['unknown', 'maintenance', 'request_state', 'authority', 'command_validation', 'command_guard', 'file_guard', 'source_plan', 'target_guard', 'cli_guard', 'policy_guard', 'busy_check', 'execution_claim', 'decision_persistence', 'decision_audit', 'evaluation_persistence', 'start_audit', 'start_persistence']);
export function dispatchStep(stage, operation, reason = 'unknown') {
  if (!stages.has(stage) || !reasons.has(reason)) throw Error('Invalid dispatch diagnostic');
  try { return operation(); } catch (error) {
    if (error !== null && ['object', 'function'].includes(typeof error) && failures.has(error)) throw error;
    const safeError = Error('Dispatch unavailable');
    failures.set(safeError, { dispatchFailureReason: reason, dispatchFailureStage: stage });
    throw safeError;
  }
}
export function dispatchRefusal(reason, stage, message) {
  if (!stages.has(stage) || !reasons.has(reason)) throw Error('Invalid dispatch diagnostic');
  const error = Error(message);
  failures.set(error, { dispatchFailureReason: reason, dispatchFailureStage: stage });
  throw error;
}
export function dispatchFailureDetails(error) {
  return { ...(error !== null && ['object', 'function'].includes(typeof error) ? failures.get(error) : undefined)
    ?? { dispatchFailureReason: 'unknown', dispatchFailureStage: 'unknown' } };
}
