import { SAFETY_PROTOCOL, SAFETY_QUESTION, safetyInput, validateAssessment, isJevModel, assessmentDiagnostic } from '../../domain/safety.mjs';
import { COMMAND_REQUEST_MAX_BYTES } from '../../contracts/ports.mjs';
import { explicitUserApproval, approvedCommandNames } from '../../domain/command-policy.mjs';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const RESPONSE_LIMIT = 64 * 1024;
const unavailable = (reason, diagnostic) => ({ status: 'unavailable', reason, ...(diagnostic ? { diagnostic } : {}) });

/** Fixed endpoint, no retries/redirects, one outstanding request per adapter. */
export function createJevAssessor({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10_000, question = SAFETY_QUESTION, questionVersion, inputKind = 'observation', model = SAFETY_PROTOCOL.model, admission = { busy: false } } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw Error('Invalid Jev timeout');
  if (!['observation', 'execution', 'registration'].includes(inputKind)) throw Error('Invalid Jev input kind');
  if (!isJevModel(model)) throw Error('Use a pinned Jev model version');
  return {
    model, ...(questionVersion ? { questionVersion } : {}),
    forModel(selected = model) { return isJevModel(selected) ? createJevAssessor({ apiKey, fetchImpl, timeoutMs, question, questionVersion, inputKind, model: selected, admission }) : undefined; },
    async listModels() {
      if (!apiKey) throw Error('Models unavailable');
      const controller = new AbortController(); let timer, reader;
      const request = (async () => {
        try {
          const response = await fetchImpl('https://api.typesafe.ai/v1/models', { redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}` } });
          if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw Error('Models unavailable');
          reader = response.body?.getReader(); if (!reader) throw Error('Models unavailable');
          const chunks = []; let size = 0;
          for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > RESPONSE_LIMIT) throw Error('Models unavailable'); chunks.push(value); }
          const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!Array.isArray(data.models) || data.models.length > 100) throw Error('Models unavailable');
          return [...new Set(data.models.map(item => item.name).filter(isJevModel))];
        } finally { if (reader) void reader.cancel().catch(() => {}); }
      })();
      try { return await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); if (reader) void reader.cancel().catch(() => {}); reject(Error('Models unavailable')); }, 5000); })]); }
      finally { clearTimeout(timer); controller.abort(); }
    },
    async assess(input, { sourcePlan } = {}) {
      if (typeof apiKey !== 'string' || !apiKey.trim()) return unavailable('not_configured');
      if (admission.busy) return unavailable('busy');
      let state;
      try {
        state = safetyInput(input, { sourcePlan: inputKind === 'execution' ? sourcePlan : undefined });
        if (inputKind === 'execution') {
          const approval = explicitUserApproval(state.command, input.preapprovedCommands);
          if (!input.userApproval || Object.keys(input.userApproval).length !== 4
            || !Object.entries(approval).every(([key, value]) => input.userApproval[key] === value)) throw Error('Invalid user approval');
          state.preapprovedCommands = [...input.preapprovedCommands]; state.userApproval = approval;
        }
        if (inputKind === 'registration') state.proposedCommands = approvedCommandNames(input.proposedCommands);
      } catch { return unavailable('invalid_input'); }
      const body = JSON.stringify({ model, state, questions: { risk: question } });
      if (Buffer.byteLength(body) > COMMAND_REQUEST_MAX_BYTES) return unavailable('input_too_large');
      admission.busy = true;
      const controller = new AbortController();
      let timer, reader, responseStage;
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); if (reader) void reader.cancel().catch(() => {}); resolve(unavailable('timeout')); }, timeoutMs);
      });
      const request = async () => {
        try {
          const response = await fetchImpl(JEV_ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body });
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return unavailable('timeout'); }
          if (!response.ok) { void response.body?.cancel().catch(() => {}); return unavailable('http_error'); }
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) return unavailable('invalid_response', 'CONTENT_TYPE');
          reader = response.body?.getReader();
          if (!reader) return unavailable('invalid_response', 'BODY_MISSING');
          responseStage = 'BODY_READ';
          const chunks = []; let size = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > RESPONSE_LIMIT) return unavailable('response_too_large');
            chunks.push(value);
          }
          responseStage = 'UTF8_DECODE';
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          responseStage = 'JSON_PARSE';
          const raw = JSON.parse(text);
          responseStage = undefined;
          if (!raw?.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)
            || Object.keys(raw.answers).length !== 1 || !Object.hasOwn(raw.answers, 'risk')) return unavailable('invalid_response', 'ANSWER_KEYS');
          const answer = raw.answers.risk;
          if (answer?.type !== 'choice') return unavailable('invalid_response', 'ANSWER_TYPE');
          const value = { status: 'assessed', model: raw.model, label: answer.choice,
            confidence: answer.confidence, probabilities: answer.probabilities,
            inputTokens: raw.usage?.input_tokens, outputTokens: raw.usage?.output_tokens };
          return validateAssessment(value, model) || unavailable('invalid_response', assessmentDiagnostic(value, model));
        } catch { return unavailable(controller.signal.aborted ? 'timeout' : 'request_failed', controller.signal.aborted ? undefined : responseStage); }
        finally { if (reader) void reader.cancel().catch(() => {}); }
      };
      // A timeout does not prove the remote call was unprocessed or free. Keep the
      // slot until transport settles, including injected transports ignoring abort.
      const pending = request().finally(() => { admission.busy = false; });
      try { return await Promise.race([pending, deadline]); }
      finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
