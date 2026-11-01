// Error text and caller-controlled properties never become diagnostic metadata.
const failures = new WeakMap();
const stages = new Set(['ssh_connect', 'ssh_channel', 'ssh_execution', 'output_reservation', 'output_capture', 'operation']);
const codes = new Set(['SSH_CONNECT_FAILED', 'SSH_CHANNEL_OPEN_FAILED', 'SSH_EXECUTION_FAILED', 'OUTPUT_CAPACITY', 'OUTPUT_CAPTURE_FAILED', 'OPERATION_FAILED']);
const outcomes = new Set(['not_started', 'unknown', 'completed']);
const unknown = Object.freeze({ stage: 'operation', code: 'OPERATION_FAILED', remoteOutcome: 'unknown', automaticReplay: false });
const object = value => value !== null && ['object', 'function'].includes(typeof value);

export function executionFailure(error, { stage, code, remoteOutcome = 'unknown' }) {
  if (object(error) && failures.has(error)) return error;
  if (!stages.has(stage) || !codes.has(code) || !outcomes.has(remoteOutcome)) throw Error('Invalid execution diagnostic');
  const safe = Error('Operation failed; inspect execution diagnostic.');
  failures.set(safe, Object.freeze({ stage, code, remoteOutcome, automaticReplay: false }));
  return safe;
}

export function executionFailureDetails(error, fallback = true) {
  const value = object(error) ? failures.get(error) : undefined;
  return value ? { ...value } : fallback ? { ...unknown } : undefined;
}

// Outcomes and durable rows are data, so validate each field again on presentation.
export function safeExecutionFailure(value) {
  if (!value || !stages.has(value.stage) || !codes.has(value.code) || !outcomes.has(value.remoteOutcome) || value.automaticReplay !== false) return undefined;
  return { stage: value.stage, code: value.code, remoteOutcome: value.remoteOutcome, automaticReplay: false };
}
