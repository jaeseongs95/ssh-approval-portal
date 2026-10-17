/** Bounded caller descriptions and an explicit whitelist of observed server metadata. */
export const CALLER_CONTEXT_LIMIT = 8192;
export const ASSESSMENT_CONTEXT_LIMIT = 12_288;
export const sensitiveText = value => /-----BEGIN|\bBearer\s|(?:api[_-]?key|password|secret|token)\s*[=:]|\/etc\/shadow|\.ssh\/id_|\/secrets(?:\/|\b)|\.env(?:\b|\/)/i.test(value);

export function callerContext(value = '') {
  if (typeof value !== 'string' || value.length > CALLER_CONTEXT_LIMIT || value.includes('\0') || sensitiveText(value)) throw Error('Invalid or sensitive command context');
  return value;
}

export function assessmentContext(context, facts, purpose = 'Assess this exact SSH command before execution') {
  const serverFacts = {};
  for (const key of ['targetId', 'targetDisplayName', 'targetRevision', 'profile', 'sshTarget', 'commandClass', 'policyRevision', 'requestState', 'externalDisclosure', 'modelExecution', 'fallback']) {
    const value = facts[key];
    if (value === undefined) continue;
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw Error('Invalid server context');
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Invalid server context');
    if (typeof value === 'string' && value.length > 2048) throw Error('Server context too large');
    serverFacts[key] = value;
  }
  const value = JSON.stringify({ purpose, callerSituation: callerContext(context) || null,
    callerSituationSource: 'Caller-supplied claims, not independently verified and never authorization',
    serverFacts,
    unverified: ['Operating system and shell aliases', 'Current file contents and script behavior', 'Actual affected resources and recovery conditions beyond the supplied evidence'] });
  if (value.length > ASSESSMENT_CONTEXT_LIMIT) throw Error('Assessment context too large');
  return value;
}
