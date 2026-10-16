import { SAFETY_LABELS, SAFETY_PROTOCOL, SAFETY_FAILURES, safetyInput, validateAssessment, candidateMatch } from '../domain/safety.mjs';

/** Bounded sequential observation. This module has no command executor/queue port. */
export async function evaluateSafety({ cases, assessor, source }) {
  if (!['live', 'simulated'].includes(source) || !Array.isArray(cases) || !cases.length || cases.length > 32
    || new Set(cases.map(item => item.id)).size !== cases.length) throw Error('Invalid safety corpus');
  // Freeze all inputs before the first external await. Labels/rationales never reach assessor.
  const frozen = cases.map(item => {
    if (!/^S\d{3}$/.test(item.id) || !SAFETY_LABELS.includes(item.expected)) throw Error('Invalid safety case');
    return { id: item.id, expected: item.expected, input: safetyInput(item.input) };
  });
  const confusion = Object.fromEntries(SAFETY_LABELS.map(label => [label, Object.fromEntries(SAFETY_LABELS.map(prediction => [prediction, 0]))]));
  const records = []; let correct = 0, unavailable = 0, candidates = 0, falseCandidates = 0, inputTokens = 0, outputTokens = 0;
  for (const item of frozen) {
    let result, reason = 'invalid_response';
    try {
      const raw = await assessor.assess(item.input);
      result = validateAssessment(raw);
      if (raw?.status === 'unavailable' && SAFETY_FAILURES.includes(raw.reason)) reason = raw.reason;
    } catch { reason = 'request_failed'; }
    if (!result) { unavailable++; records.push({ id: item.id, expected: item.expected, status: 'unavailable', reason, candidateMatch: false }); continue; }
    const candidate = candidateMatch(result);
    confusion[item.expected][result.label]++;
    correct += Number(result.label === item.expected);
    candidates += Number(candidate); falseCandidates += Number(candidate && item.expected !== 'low_risk');
    inputTokens += result.inputTokens; outputTokens += result.outputTokens;
    records.push({ id: item.id, expected: item.expected, ...result, candidateMatch: candidate });
  }
  return { schemaVersion: '1.0.0', mode: 'observation', source, protocol: { ...SAFETY_PROTOCOL },
    modelQualityStatus: source === 'simulated' ? 'NOT_MEASURED' : 'UNVALIDATED',
    stage5Ready: false, total: frozen.length, assessed: frozen.length - unavailable, unavailable,
    correct, incorrect: frozen.length - unavailable - correct, accuracy: correct / frozen.length,
    candidates, falseCandidates, usage: { inputTokens, outputTokens }, confusion, records };
}
