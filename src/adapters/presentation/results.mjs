import { z } from 'zod';
import { fileTargetBinding } from '../../domain/file-target-binding.mjs';
import { executionFailureDetails, safeExecutionFailure } from '../../domain/execution-failure.mjs';

const identifier = z.string().regex(/^[a-f0-9]{48}$/);
const state = z.enum(['pending', 'evaluating', 'queued', 'running', 'completed', 'failed', 'denied', 'expired', 'unknown']);
const content = z.array(z.object({ type: z.literal('text'), text: z.string() }));
const outcome = z.object({ failed: z.boolean(), texts: z.array(z.string()), data: z.object({}).passthrough().optional() });
const legacyOutcome = z.object({ content, isError: z.boolean().optional(), structuredContent: z.object({}).passthrough().optional() }).passthrough();
const outputReference = z.object({ version: z.literal(1), captureSource: z.literal('redacted-adapter-outcome'), sshCompleteness: z.literal('unknown'),
  id: identifier, executionId: identifier, state: z.enum(['ready', 'unavailable', 'expired']), expiresAt: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative().optional(), snapshotBytes: z.number().int().nonnegative().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: z.string() }).passthrough(),
  z.object({ kind: z.literal('upload'), artifactId: identifier, remotePath: z.string(), fileName: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), overwrite: z.boolean(), elevate: z.boolean() }).passthrough(),
  z.object({ kind: z.literal('download'), remotePath: z.string(), elevate: z.boolean() }).passthrough(),
]);
const jobFields = {
  id: identifier, kind: z.enum(['command', 'upload', 'download']), operation,
  command: z.string().optional(), profile: z.string(), commandClass: z.string(), target: z.string(), state,
  approvalMode: z.enum(['automatic', 'owner']).optional(),
  createdAt: z.number(), expiresAt: z.number(), finishedAt: z.number().optional(), result: legacyOutcome.optional(), auditError: z.string().optional(),
};
const jobSchema = z.object(jobFields).passthrough();
const immediateSchema = z.object({ kind: z.literal('command'), state: z.enum(['completed', 'failed']) }).passthrough();
const unknownSchema = z.object({ error: z.literal('Unknown request; server may have restarted') });
const sourceUnavailableSchema = z.object({ error: z.literal('upload-source-not-configured'), sourceHost: z.string(), message: z.string() });
const targetId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const transferSchema = z.object({
  transfer: z.object({ target: targetId.optional(), direction: z.enum(['upload', 'download']), remotePath: z.string(), elevate: z.boolean(), overwrite: z.boolean() }),
  uiEnabled: z.boolean(), maxBytes: z.number().int().positive(),
  setup: z.object({ tool: z.literal('get-client-setup'), guidance: z.string().min(1).max(2048) }).strict(),
});

// SDK 1.32.1 only normalizes object output schemas. Presenters validate exact variants;
// the registered object schemas describe common required and variant-specific fields.
export const outputSchemas = {
  immediate: immediateSchema,
  job: jobSchema,
  run: z.object({ ...Object.fromEntries(Object.entries(jobFields).map(([key, value]) => [key, value.optional()])), kind: z.literal('command'), state }).passthrough(),
  status: z.object({ ...Object.fromEntries(Object.entries(jobFields).map(([key, value]) => [key, value.optional()])), error: z.string().optional() }).passthrough(),
  upload: z.object({ ...Object.fromEntries(Object.entries(jobFields).map(([key, value]) => [key, value.optional()])), error: z.literal('upload-source-not-configured').optional(), sourceHost: z.string().optional(), message: z.string().optional() }).passthrough(),
  transfer: transferSchema,
  begin: z.object({ transferId: identifier, received: z.literal(0) }),
  chunk: z.object({ sequence: z.number().int().nonnegative(), received: z.number().int().nonnegative() }),
  ready: z.object({ ready: z.literal(true), fileName: z.string() }),
  targets: z.object({ targets: z.array(z.object({ id: targetId, displayName: z.string(), enabled: z.boolean(), isDefault: z.boolean(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    platform: z.enum(['linux', 'windows']).optional(), capabilities: z.object({ commandShell: z.enum(['posix', 'windows-powershell-5.1']), fileTransfer: z.boolean(), elevatedFileTransfer: z.boolean(), pythonSource: z.boolean(), agentCli: z.boolean(), commandNameApproval: z.boolean() }).optional(),
    filePolicy: z.object({ testServerConfigured: z.boolean(), testServerActive: z.boolean(), mode: z.enum(['configured-root', 'test-server-bypass', 'ssh-account-permissions']),
      allowedRoot: z.string().max(4096).nullable(), allowedRootObservedAt: z.number().int().nonnegative().nullable(),
      osPermissionsEnforced: z.literal(true), pathSafetyEnforced: z.literal(true), elevationRequiresExplicitRequest: z.literal(true) }).strict().optional() })), defaultTarget: targetId.nullable() }),
  probe: z.object({ probe: z.literal('SSH_UI_PUBLIC_PROBE'), uiEnabled: z.boolean() }),
  safety: z.object({ id: identifier, subject: z.string().regex(/^[a-f0-9]{64}$/), targetId,
    targetRevision: z.string().optional(), advisory: z.literal(true), automaticExecutionEnabled: z.literal(false),
    assessment: z.object({ status: z.enum(['assessed', 'unavailable']) }).passthrough(),
    provenance: z.object({ purpose: z.literal('observation'), cached: z.boolean(), assessedAt: z.number(), latencyMs: z.number(),
      requestState: z.string(), inputRevision: z.literal(1), storedContextProvided: z.boolean(), additionalContextApplied: z.boolean(),
      inputStatus: z.enum(['first_assessment', 'same_input', 'input_changed_not_reassessed']), historical: z.boolean() }).optional() }),
};

export function presentOutcome(value) {
  outcome.parse(value);
  return { content: value.texts.map(text => ({ type: 'text', text })), ...(value.failed ? { isError: true } : {}), ...(value.data !== undefined ? { structuredContent: value.data } : {}) };
}

// Commands carry only an allowlisted descriptor, including legacy journal entries.
// Never expand command data or preview text through a default response.
export function presentCommandOutcome(value) {
  const parsed = outputReference.safeParse(value.output);
  const output = parsed.success ? parsed.data : { state: 'unavailable' };
  if (typeof output.expiresAt === 'number' && Date.now() >= output.expiresAt) output.state = 'expired';
  const failure = safeExecutionFailure(value.failure);
  return { content: [], ...(value.failed ? { isError: true } : {}), structuredContent: { output, ...(failure ? { failure } : {}) } };
}

export function presentJob(job) {
  if (job.kind !== 'command') fileTargetBinding(job.operation);
  const value = { id: job.id, kind: job.kind, operation: { ...job.operation }, command: job.command,
    ...(job.targetId === undefined ? {} : { targetId: job.targetId, targetRevision: job.targetRevision, targetDisplayName: job.targetDisplayName, hostKey: job.hostKey }),
    ...(job.decision ? { decision: structuredClone(job.decision) } : {}), profile: job.profile, commandClass: job.commandClass, target: job.target, state: job.state,
    ...(job.approvalMode ? { approvalMode: job.approvalMode } : {}),
    createdAt: job.createdAt, expiresAt: job.expiresAt, finishedAt: job.finishedAt,
    result: job.result === undefined ? undefined : job.kind === 'command' ? presentCommandOutcome(job.result) : presentOutcome(job.result), auditError: job.auditError };
  jobSchema.parse(value);
  return value;
}

export function publicResult(value, schema) {
  schema.parse(value);
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export const jobResult = job => publicResult({ ...presentJob(job),
  ...(job.state === 'queued' ? { message: 'Approval is complete. This request is waiting for its execution turn. Call wait-for-request with the same ID and until: completion; never resubmit or approve it again.' } : {}),
  ...(['pending', 'evaluating'].includes(job.state) ? { approvalCallback: {
    tool: 'wait-for-request', arguments: { id: job.id, until: 'approval', timeoutMs: 25000 },
    instruction: 'After presenting owner approval, call wait-for-request to receive the decision without asking the user to confirm in chat. On timeout, wait on the same ID; never resubmit the operation.',
  } } : {}),
}, jobSchema);
export const statusResult = job => job ? jobResult(job) : publicResult({ error: 'Unknown request; server may have restarted' }, unknownSchema);
export function immediateResult(value, identity) {
  const result = presentCommandOutcome(value);
  return { ...publicResult({ state: value.failed ? 'failed' : 'completed', kind: 'command', ...identity, ...result.structuredContent }, immediateSchema), ...(value.failed ? { isError: true } : {}) };
}
export const sourceUnavailable = sourceHost => ({ ...publicResult({ error: 'upload-source-not-configured', sourceHost,
  message: 'File was not fetched or queued. An administrator must configure a verified exact hostname or *.domain pattern for this provider. Check get-client-capabilities and get-client-setup for local CLI or stdio file transports; the card file picker is an alternative only when supported and enabled. Missing cards do not prove those local transports are unavailable.' }, sourceUnavailableSchema), isError: true });
const contextRefusals = new Map([
  ['INVALID_COMMAND_CONTEXT', 'Command context must be text without NUL characters.'],
  ['COMMAND_CONTEXT_TOO_LARGE', 'Command context exceeds the 8192-character limit.'],
  ['COMMAND_CONTEXT_CONTAINS_SECRET', 'Command context contains credential material or a credential assignment. Do not include secret values.'],
]);
const sourceRefusals = new Map([
  ['SOURCE_CREDENTIAL_MATERIAL', { inputField: 'source', ruleId: 'credential-material-v1', text: '제출 원문이 인증정보 입력 금지 규칙에 일치합니다.' }],
  ['SOURCE_ARGUMENTS_SENSITIVE', { inputField: 'argv', ruleId: 'sensitive-input-v1', text: '제출 인수가 민감 입력 금지 규칙에 일치합니다.' }],
  ['SOURCE_WORKDIR_SENSITIVE', { inputField: 'cwd', ruleId: 'sensitive-input-v1', text: '작업 경로가 민감 입력 금지 규칙에 일치합니다.' }],
]);
const readRefusals = new Map([
  ['READ_COMMAND_BUSY', { executionAttempted: false, message: '유지보수 또는 다른 작업이 진행 중이어서 읽기 명령을 시작하지 않았습니다. 자동으로 재제출하지 마세요.' }],
  ['READ_COMMAND_REQUIRES_APPROVAL', { executionAttempted: false, message: '이 명령은 읽기 전용 허용 범위 밖이어서 실행하지 않았습니다. 세미콜론으로 연결한 복합 명령도 해당할 수 있습니다. 기존 작업 권한을 확인한 뒤 정확한 명령을 run-command로 제출해 서버 정책과 필요한 승인을 받으세요. 자동 전환하거나 명령을 나누어 제한을 우회하지 마세요.' }],
  ['READ_COMMAND_NOT_STARTED', { executionAttempted: false, message: '실행 자원 확보 또는 시작 감사 기록에 실패해 읽기 명령을 시작하지 않았습니다. 보호된 서버 진단을 확인하고 자동으로 재제출하지 마세요.' }],
  ['READ_COMMAND_EXECUTION_UNKNOWN', { executionAttempted: true, message: '읽기 실행기를 호출했지만 오류가 발생해 원격 실행 여부나 완료를 확정할 수 없습니다. 명령을 다시 실행하거나 다른 도구로 재제출하지 말고 보호된 서버 진단을 확인하세요.' }],
]);
export const refused = error => {
  const source = sourceRefusals.get(error?.code);
  if (source) return { isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error_code: error.code, inputField: source.inputField, ruleId: source.ruleId,
      stage: 'source_admission', requestSubmitted: false, message: `${source.text} 요청은 등록되지 않았습니다.` }) }] };
  const read = readRefusals.get(error?.code);
  const failure = executionFailureDetails(error, false);
  if (read) return { isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error_code: error.code,
      stage: read.executionAttempted ? 'read_execution' : 'read_admission', executionAttempted: read.executionAttempted,
      requestSubmitted: false, message: read.message, ...(failure ? { failure } : {}) }) }] };
  return { isError: true, content: [{ type: 'text', text: contextRefusals.has(error?.code)
    ? `${error.code}: ${contextRefusals.get(error.code)} No command was submitted.`
    : 'Request refused or failed. Check authentication, state, limits and permissions.' }] };
};
