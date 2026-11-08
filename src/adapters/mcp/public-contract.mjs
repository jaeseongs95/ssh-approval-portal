import { z } from 'zod';
import { CHUNK_BYTES, MAX_BYTES, COMMAND_MAX_BYTES, PYTHON_SOURCE_MAX_BYTES, OUTPUT_PAGE_BYTES, utf8WithinLimit } from '../../contracts/ports.mjs';
import { CALLER_CONTEXT_LIMIT } from '../../domain/execution-context.mjs';

export const CONTRACT_VERSION = '2.0';
const object = fields => z.object(fields).strict();
const identifier = z.string().regex(/^[a-f0-9]{48}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const target = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
// Unlike $, this end assertion also rejects a final CR/LF in JSON Schema clients.
const key = z.string().regex(/^[A-Za-z0-9_.:-]{16,128}(?![\s\S])/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/);
const integer = z.number().int().nonnegative();
const textBytes = limit => z.string().min(1).max(limit).refine(value => utf8WithinLimit(value, limit), `Maximum ${limit} UTF-8 bytes`);
export const operationState = z.enum(['accepted', 'pending', 'evaluating', 'queued', 'starting', 'running', 'terminating', 'completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const outputReference = object({ version: z.literal(1), captureSource: z.literal('redacted-adapter-outcome'), sshCompleteness: z.literal('unknown'),
  id: identifier.nullable(), state: z.enum(['pending', 'ready', 'unavailable', 'expired']),
  bytes: integer.nullable(), snapshotBytes: integer.nullable(), sha256: digest.nullable(), expiresAt: integer.nullable() });
const outputPage = object({ text: z.string(), cursor: integer, nextCursor: integer, bytes: integer, totalBytes: integer,
  sha256: digest, eof: z.boolean(), expiresAt: integer });
const artifact = object({ fileName: z.string(), size: integer, sha256: digest });
const diagnostic = object({ origin: z.enum(['policy', 'os']), policyReason: z.string().nullable(), nativeStep: z.string().nullable(), nativeError: integer.nullable() });
const streamMetadata = object({ receivedBytes: integer, retainedBytes: integer, cursor: integer, truncated: z.boolean() });
const executionFields = {
  phase: z.literal('settled').nullable(), reason: z.enum(['exit', 'deadline', 'cancel', 'transport_lost', 'channel_open_failed', 'input_failed']).nullable(),
  remoteState: z.enum(['not_dispatched', 'exited', 'unknown']).nullable(), exitCode: z.number().int().nullable(),
  signal: z.string().regex(/^[A-Z0-9_-]{1,32}$/).nullable(), automaticReplay: z.literal(false).nullable(),
  signalDelivery: z.enum(['requested', 'unsupported']).nullable(),
  timeoutMs: z.number().int().positive().nullable(), cleanupComplete: z.boolean().nullable(), requiresReconciliation: z.boolean().nullable(),
  outputState: z.enum(['partial', 'complete']).nullable(), captureFailed: z.boolean().nullable(),
  stdout: streamMetadata.nullable(), stderr: streamMetadata.nullable(),
};
const executionData = object(executionFields);
function presentExecution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(executionFields).map(([field, schema]) => {
    const parsed = schema.safeParse(value[field]);
    return [field, parsed.success ? parsed.data : null];
  }));
}
export const operationData = object({ id: identifier, operationKey: key.nullable(), kind: z.enum(['command', 'source', 'upload', 'download']), state: operationState,
  targetId: target.nullable(), targetRevision: digest.nullable(), approvalMode: z.enum(['owner', 'automatic']).nullable(),
  createdAt: integer, expiresAt: integer.nullable(), finishedAt: integer.nullable(),
  failed: z.boolean().nullable(), auditFailure: z.boolean(), failureCode: z.string().nullable(), remoteOutcome: z.enum(['not_started', 'completed', 'unknown']).nullable(),
  allowedRoot: z.string().nullable(), diagnostic: diagnostic.nullable(), remoteCleanup: z.enum(['confirmed', 'unconfirmed']).nullable(),
  execution: executionData.nullable(), output: outputReference.nullable(), artifact: artifact.nullable(), outputPage: outputPage.nullable(), streamPage: z.null(), waitTimedOut: z.boolean() });
const policy = object({ testServerConfigured: z.boolean(), testServerActive: z.boolean(), mode: z.enum(['configured-root', 'test-server-bypass', 'ssh-account-permissions']),
  allowedRoot: z.string().nullable(), allowedRootObservedAt: integer.nullable(), osPermissionsEnforced: z.literal(true),
  pathSafetyEnforced: z.literal(true), elevationRequiresExplicitRequest: z.literal(true) });
const openRequestKey = z.string().regex(/^[a-f0-9]{32}_[0-9]{1,16}_[a-f0-9]{32}_[A-Za-z0-9_-]{43}(?![\s\S])/);
const guiDescriptor = object({ configured: z.boolean(), backend: z.enum(['rfb', 'xvnc', 'rdp']).nullable(),
  lifecycle: z.enum(['attached', 'managed']).nullable(), status: z.enum(['disabled', 'configured', 'backend_unavailable']),
  reason: z.string().max(256).nullable(), actions: z.array(z.enum(['observe', 'pointer', 'key', 'text'])).max(4), requiresUserClient: z.literal(false), openRequest: object({ requestKey: openRequestKey, expiresAt: integer }).optional() });
const targetData = object({ targets: z.array(object({ id: target, displayName: z.string(), enabled: z.boolean(), isDefault: z.boolean(),
  revision: digest.nullable(), platform: z.enum(['linux', 'windows']), capabilities: object({
    commandShell: z.enum(['posix', 'windows-powershell-5.1']), fileTransfer: z.boolean(), elevatedFileTransfer: z.boolean(),
    pythonSource: z.boolean(), agentCli: z.boolean(), commandNameApproval: z.boolean(), desktop: z.boolean(),
  }), gui: guiDescriptor.optional(), filePolicy: policy.nullable() })), defaultTarget: target.nullable(),
  limits: object({ commandBytes: integer, sourceBytes: integer, artifactBytes: integer, chunkBytes: integer, outputPageBytes: integer, maxWaitMs: integer }),
  approval: object({ ownerUrl: z.string().url(), agentSelfApproval: z.literal(false) }) });
const transfer = object({ id: identifier, received: integer, sequence: integer, size: integer.max(MAX_BYTES), sha256: digest,
  expiresAt: integer, targetId: target, targetRevision: digest });
const beginData = transfer.extend({ maxChunkBytes: z.literal(CHUNK_BYTES) });
const transferStatus = object({ state: z.enum(['staging', 'ready', 'expired', 'submitted']), transfer: transfer.nullable(), request: operationData.nullable() });
const chunkData = object({ sequence: integer, received: integer });
const artifactPage = object({ id: identifier, artifactId: identifier, fileName: z.string(), encoding: z.literal('base64'), data: z.string(),
  offsetBytes: integer, bytes: integer.max(CHUNK_BYTES), nextOffset: integer, totalBytes: integer.max(MAX_BYTES), sha256: digest, eof: z.boolean(), expiresAt: integer });
const stagedFile = object({ uuid, state: z.enum(['staging', 'ready', 'expired', 'consuming', 'moved', 'removed']),
  fileName: z.string().min(1).max(255), size: integer.max(MAX_BYTES), sha256: digest, expiresAt: integer,
  received: integer, sequence: integer,
  operations: z.array(object({ operationKey: key, action: z.enum(['copy', 'move']), requestId: identifier,
    state: z.enum(['accepted', 'queued', 'starting', 'running', 'terminating', 'completed', 'failed', 'cancelled', 'expired', 'denied', 'unknown', 'admission-unconfirmed', 'refused']) })) });
const errorData = object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,95}$/), retryable: z.boolean(), executionAttempted: z.union([z.boolean(), z.literal('unknown')]) });
export const responseSchema = data => object({ contractVersion: z.literal(CONTRACT_VERSION), ok: z.boolean(), data: data.nullable(), error: errorData.nullable() })
  .refine(value => value.ok ? value.data !== null && value.error === null : value.data === null && value.error !== null, 'Expected data or error');

export const publicInputSchemas = {
  targets: object({}),
  submit: object({ kind: z.enum(['command', 'source', 'download']), operationKey: key, target: target.optional(), expectedTargetRevision: digest.optional(),
    command: textBytes(COMMAND_MAX_BYTES).optional(), source: textBytes(PYTHON_SOURCE_MAX_BYTES).optional(),
    argv: z.array(z.string().max(512)).max(16).optional(), cwd: z.string().min(1).max(512).optional(),
    remotePath: z.string().min(1).max(4096).optional(), elevate: z.boolean().optional(),
    context: z.string().max(CALLER_CONTEXT_LIMIT).optional(), displayContext: z.string().max(CALLER_CONTEXT_LIMIT).optional() }),
  observe: object({ id: identifier.optional(), operationKey: key.optional(), waitMs: integer.max(60000).default(0), includeOutput: z.boolean().default(false),
    cursor: integer.default(0), maxBytes: z.number().int().min(4).max(OUTPUT_PAGE_BYTES).default(4096) }),
  cancel: object({ id: identifier }),
  files: object({ action: z.enum(['stat', 'copy', 'move', 'remove']), uuid, operationKey: key.optional(), target: target.optional(),
    expectedTargetRevision: digest.optional(), remotePath: z.string().min(1).max(4096).optional(), overwrite: z.boolean().optional(), elevate: z.boolean().optional() }),
  'artifact-begin': object({ operationKey: key, target, expectedTargetRevision: digest, fileName: z.string().min(1).max(255), size: integer.max(MAX_BYTES), sha256: digest,
    remotePath: z.string().min(1).max(4096), overwrite: z.boolean().default(false), elevate: z.boolean().default(false) }),
  'artifact-chunk': object({ id: identifier, sequence: integer, data: z.string().min(1).max(Math.ceil(CHUNK_BYTES / 3) * 4) }),
  'artifact-status': object({ id: identifier }), 'artifact-finish': object({ id: identifier }),
  'artifact-read': object({ id: identifier, offsetBytes: integer.default(0), maxBytes: z.number().int().min(1).max(CHUNK_BYTES).default(65536) }),
};
export const publicOutputSchemas = {
  targets: responseSchema(targetData), submit: responseSchema(operationData), observe: responseSchema(operationData), cancel: responseSchema(operationData),
  files: responseSchema(object({ action: z.enum(['stat', 'copy', 'move', 'remove']), uuid, file: stagedFile, request: operationData.nullable() })),
  'artifact-begin': responseSchema(beginData), 'artifact-chunk': responseSchema(chunkData), 'artifact-status': responseSchema(transferStatus),
  'artifact-finish': responseSchema(operationData), 'artifact-read': responseSchema(artifactPage),
};

function failure(code) { throw Object.assign(Error(code), { code, executionAttempted: false }); }
export function validateSubmit(input) {
  const fields = { command: ['command', 'context', 'displayContext'], source: ['source', 'argv', 'cwd', 'elevate', 'context', 'displayContext'], download: ['remotePath', 'elevate', 'context', 'displayContext'] };
  const common = ['kind', 'operationKey', 'target', 'expectedTargetRevision'];
  if (Object.keys(input).some(field => ![...common, ...fields[input.kind]].includes(field))) failure('OPERATION_INPUT_CONFLICT');
  if (input.kind === 'command' && !input.command || input.kind === 'source' && (!input.source || !input.cwd)
    || input.kind === 'download' && !input.remotePath) failure('OPERATION_INPUT_REQUIRED');
  return input;
}
export function decodeArtifactChunk(data) {
  if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) failure('ARTIFACT_INVALID_CHUNK');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== data) failure('ARTIFACT_INVALID_CHUNK');
  return bytes;
}

// Explicit projection keeps output bodies, private tickets and vendor host objects out of status replies.
export function presentOperation(value, { includeOutput = false } = {}) {
  const job = value?.job ?? value;
  if (!job?.id) failure('OPERATION_NOT_FOUND');
  const result = job.result ?? {}, output = job.output ?? result.output, file = result.data;
  const page = includeOutput ? value?.outputPage : null, detail = file?.diagnostic;
  return operationData.parse({ id: job.id, operationKey: job.operationKey ?? job.requestKey ?? null,
    kind: job.operation?.sourceContract ? 'source' : job.kind, state: job.state,
    targetId: job.targetId ?? null, targetRevision: job.targetRevision ?? null, approvalMode: job.approvalMode ?? null,
    createdAt: job.createdAt, expiresAt: job.expiresAt ?? null, finishedAt: job.finishedAt ?? null,
    failed: typeof result.failed === 'boolean' ? result.failed : null, auditFailure: Boolean(job.auditError), failureCode: result.failure?.code ?? file?.errorCode ?? null,
    remoteOutcome: result.failure?.remoteOutcome ?? null, allowedRoot: file?.allowedRoot ?? null,
    diagnostic: detail ? { origin: detail.origin, policyReason: detail.policyReason ?? null, nativeStep: detail.nativeStep ?? null, nativeError: detail.nativeError ?? null } : null,
    remoteCleanup: file?.remoteCleanup ?? null,
    execution: presentExecution(result.execution),
    output: output ? { version: 1, captureSource: 'redacted-adapter-outcome', sshCompleteness: 'unknown',
      id: output.id ?? null, state: typeof output.expiresAt === 'number' && Date.now() >= output.expiresAt ? 'expired' : output.state,
      bytes: output.bytes ?? null, snapshotBytes: output.snapshotBytes ?? null,
      sha256: output.sha256 ?? null, expiresAt: output.expiresAt ?? null } : null,
    artifact: job.kind === 'download' && job.state === 'completed' && file?.fileName && Number.isSafeInteger(file.size) && file.sha256
      ? { fileName: file.fileName, size: file.size, sha256: file.sha256 } : null,
    outputPage: page ? { text: page.text, cursor: page.cursor ?? page.offsetBytes, nextCursor: page.nextCursor ?? page.nextOffset,
      bytes: page.bytes, totalBytes: page.totalBytes, sha256: page.sha256, eof: page.eof, expiresAt: page.expiresAt } : null,
    streamPage: null,
    waitTimedOut: value?.waitTimedOut === true || value?.event === 'timeout' });
}

export function publicReply(data, schema) {
  const value = schema.parse({ contractVersion: CONTRACT_VERSION, ok: true, data, error: null });
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
const transferRefusals = new Map([
  ['Invalid filename', 'ARTIFACT_INVALID_FILENAME'], ['Invalid file hash', 'ARTIFACT_INVALID_HASH'], ['File exceeds transfer limit', 'ARTIFACT_LIMIT'],
  ['Staging budget exhausted', 'ARTIFACT_QUOTA'], ['Chunk sequence or size mismatch', 'ARTIFACT_SEQUENCE_OR_SIZE'], ['Transfer is not writable', 'ARTIFACT_NOT_WRITABLE'],
  ['Incomplete or expired upload', 'ARTIFACT_INCOMPLETE_OR_EXPIRED'], ['Artifact hash mismatch', 'ARTIFACT_HASH_MISMATCH'], ['Unknown transfer', 'ARTIFACT_UNKNOWN'],
  ['Maintenance or file service closed', 'ARTIFACT_MAINTENANCE'], ['Stale or invalid file target', 'ARTIFACT_STALE_TARGET'], ['Stale artifact', 'ARTIFACT_STALE_TARGET'],
  ['Stale MCP upload target', 'ARTIFACT_STALE_TARGET'], ['Not a bound MCP JSON upload', 'ARTIFACT_WRONG_PROTOCOL'],
  ['Target configuration changed; restart and request fresh approval', 'ARTIFACT_STALE_TARGET'], ['Select a registered enabled target', 'TARGET_UNAVAILABLE'],
  ['MCP upload already submitted; read its status', 'ARTIFACT_ALREADY_SUBMITTED'],
  ['Original upload request unavailable; do not replay', 'ARTIFACT_REQUEST_UNAVAILABLE'],
  ['Invalid download page', 'ARTIFACT_INVALID_RANGE'], ['Download offset exceeds artifact', 'ARTIFACT_INVALID_RANGE'],
  ['Download is not ready', 'ARTIFACT_NOT_READY'], ['Download artifact binding or retention mismatch', 'ARTIFACT_BINDING_OR_RETENTION'],
  ['Download artifact changed', 'ARTIFACT_CHANGED'], ['Bound file target verifier unavailable', 'ARTIFACT_TARGET_VERIFIER_UNAVAILABLE'],
]);
function publicError(error, schema) {
  const code = /^[A-Z][A-Z0-9_]{1,95}$/.test(error?.code) ? error.code : transferRefusals.get(error?.message) ?? 'REQUEST_REFUSED';
  const value = schema.parse({ contractVersion: CONTRACT_VERSION, ok: false, data: null, error: { code, retryable: error?.retryable === true,
    executionAttempted: typeof error?.executionAttempted === 'boolean' ? error.executionAttempted : error?.accepted === false ? false : 'unknown' } });
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function registerPublicTools(server, { operations, files, opaqueFiles, settings, targets, shutdownSignal, requestSignal, admission, desktop }) {
  const register = (name, handler, description, readOnly = false) => server.registerTool(name, {
    description, inputSchema: publicInputSchemas[name], outputSchema: publicOutputSchemas[name],
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly },
  }, async (args, extra) => {
    const schema = publicOutputSchemas[name];
    try {
      const signal = AbortSignal.any([shutdownSignal, requestSignal, extra?.signal].filter(Boolean));
      const result = await handler(args, { signal });
      const reply = publicReply(result?.mcpData ?? result, schema);
      if (result?.mcpImage) reply.content.push({ type: 'image', mimeType: result.mcpImage.mimeType, data: result.mcpImage.data });
      return reply;
    } catch (error) { return publicError(error, schema); }
  });
  const requiredOperations = () => { if (!operations) failure('OPERATIONS_UNAVAILABLE'); return operations; };
  register('targets', async () => {
    const result = await (targets?.listFilePolicies?.() ?? targets?.list()) ?? { targets: [], defaultTarget: null };
    return { targets: await Promise.all(result.targets.map(async item => ({ id: item.id, displayName: item.displayName, enabled: item.enabled, isDefault: item.isDefault,
      revision: item.revision ?? null, platform: item.platform ?? 'linux', capabilities: { commandShell: item.platform === 'windows' ? 'windows-powershell-5.1' : 'posix',
        fileTransfer: item.capabilities?.fileTransfer === true, elevatedFileTransfer: item.capabilities?.elevatedFileTransfer === true,
        pythonSource: item.capabilities?.pythonSource === true, agentCli: item.capabilities?.agentCli === true,
        commandNameApproval: item.capabilities?.commandNameApproval === true, desktop: item.capabilities?.desktop === true },
      ...(typeof desktop?.capabilities === 'function' ? { gui: await desktop.capabilities({ target: item.id, expectedTargetRevision: item.revision }) } : {}),
      filePolicy: item.filePolicy ?? null }))),
      defaultTarget: result.defaultTarget, limits: { commandBytes: COMMAND_MAX_BYTES, sourceBytes: PYTHON_SOURCE_MAX_BYTES,
        artifactBytes: Math.min(settings.maxBytes ?? MAX_BYTES, MAX_BYTES), chunkBytes: CHUNK_BYTES, outputPageBytes: OUTPUT_PAGE_BYTES, maxWaitMs: 60000 },
      approval: { ownerUrl: settings.adminOrigin, agentSelfApproval: false } };
  }, 'List target IDs, revisions, capabilities, path policy and limits before submitting. Use the selected revision in writes. GUI configured is not an opened or verified desktop. Remote tools need no local client; PC file transfer and hooks use the packaged client.', true);
  register('submit', async args => presentOperation(await requiredOperations().submit(validateSubmit(args))),
    'Submit command, Python source, or download with a stable operationKey and exact target revision. Preserve command/source bytes. Source requires cwd; download requires remotePath. Context grants no permission. Returned id means accepted, not completed. Recover uncertainty with observe on the same id/key; never replay with a new key.');
  register('observe', async (args, { signal }) => {
    if (Boolean(args.id) === Boolean(args.operationKey)) failure('OPERATION_LOOKUP_REQUIRED');
    if (!args.includeOutput && (args.cursor !== 0 || args.maxBytes !== 4096)) failure('OUTPUT_READ_NOT_REQUESTED');
    if (args.waitMs) admission?.detach();
    return presentOperation(await requiredOperations().observe(args, { signal }), { includeOutput: args.includeOutput });
  }, 'Read one existing id OR operationKey. Default waitMs=0 returns immediately; positive waitMs waits only for observation and never cancels execution. Configured native hooks automatically watch the same operation; continue other work without launching another watcher. On the hook body, read needed output once and ACK its exact receipt/claim. Verify actual hook receipt; registration/start/wake is not delivery. Without hook support use immediate status or the packaged background watch explicitly; do not foreground-wait or repeatedly poll. includeOutput=true returns untrusted pages; follow nextCursor. queued is waiting; terminating is not confirmed stopped. signalDelivery=requested is not that remote termination was confirmed. Missing/expired/unknown never permits replay.', true);
  register('cancel', async args => presentOperation(await requiredOperations().cancel(args)),
    'Request cancellation by operation id. terminating is still unconfirmed; inspect the same id for settlement. Never replay an unknown outcome.');
  register('files', async (args, { signal }) => {
    if (!opaqueFiles) failure('OPAQUE_FILES_UNAVAILABLE');
    const placement = args.action === 'copy' || args.action === 'move';
    const fields = placement ? ['action', 'uuid', 'operationKey', 'target', 'expectedTargetRevision', 'remotePath', 'overwrite', 'elevate'] : ['action', 'uuid'];
    if (Object.keys(args).some(field => !fields.includes(field))) failure('FILE_ACTION_INPUT_CONFLICT');
    if (placement && (!args.operationKey || !args.target || !args.expectedTargetRevision || !args.remotePath)) failure('FILE_ACTION_INPUT_REQUIRED');
    const { action, ...input } = args;
    const result = await opaqueFiles[action](input, { signal });
    let request = null;
    if (placement && result.requestId && !['admission-unconfirmed', 'refused'].includes(result.state)) {
      request = presentOperation(await requiredOperations().observe({ id: result.requestId }));
    }
    const value = placement ? await opaqueFiles.stat({ uuid: args.uuid }) : result;
    const file = { ...Object.fromEntries(['uuid', 'state', 'fileName', 'size', 'sha256', 'expiresAt', 'received', 'sequence'].map(field => [field, value[field]])),
      operations: (value.operations ?? []).map(operation => Object.fromEntries(['operationKey', 'action', 'requestId', 'state'].map(field => [field, operation[field]]))) };
    return { action, uuid: args.uuid, file, request };
  }, 'Use a staged UUID from portal-files upload: stat reads metadata; copy retains it; move consumes it after confirmed publication; remove deletes staged bytes only. Copy/move require operationKey, target, expectedTargetRevision and remotePath. Observe data.request.id; pending/queued is not publication. If request is null, inspect file.operations on the same UUID. Policy and SSH permissions apply; no PC or internal staging paths are exposed.');
  register('artifact-begin', async args => {
    const item = await files.beginAgentUpload(args);
    return { ...Object.fromEntries(['id', 'received', 'sequence', 'size', 'sha256', 'expiresAt', 'targetId', 'targetRevision'].map(field => [field, item[field]])), maxChunkBytes: CHUNK_BYTES };
  }, 'Reserve a byte upload bound to operationKey, target revision, destination, size and SHA-256. Use when authorized bytes are already available. For PC files, run packaged portal-files upload --file PATH outside the model and use its UUID with files. This tool cannot read PC paths and starts no SSH work; retain the transfer id.');
  register('artifact-chunk', async ({ id, sequence, data }) => files.appendAgentUpload({ id, sequence, bytes: decodeArtifactChunk(data) }),
    'Append 1..262144 authorized bytes as canonical base64 to a transfer id; sequence starts at 0. Identical acknowledged chunks are idempotent while writable. On uncertainty read artifact-status for that id. Avoid model transcription of large PC files; use portal-files upload.');
  register('artifact-status', ({ id }) => {
    const value = files.agentUploadStatus(id);
    return value.state === 'submitted' ? { state: value.state, transfer: null, request: presentOperation(value.job) }
      : { state: value.state, transfer: value.transfer, request: null };
  }, 'Read progress or the submitted request for the same transfer id, not a staged UUID. Missing/expired state or uncertain finish does not permit a replacement transfer.', true);
  register('artifact-finish', async ({ id }) => presentOperation(await files.finishAgentUpload(id)),
    'Verify transfer size/SHA-256 and submit under file policy. Observe the returned operation id for actual publication. On uncertainty inspect artifact-status with the original transfer id; do not upload again.');
  register('artifact-read', async args => {
    if (typeof files.readDownload !== 'function') failure('ARTIFACT_READ_UNAVAILABLE');
    return files.readDownload(args);
  }, 'Read a base64 page using the completed download operation id, not a path or UUID. Follow nextOffset to eof and verify totalBytes/SHA-256. completed means server snapshot ready, not saved on the PC. Only that authorized snapshot and current target revision are readable.', true);
  if (desktop) registerDesktopTools(register, desktop);
}

const sessionId = z.string().uuid();
const sessionIdentity = { sessionId, epoch: z.number().int().positive() };
const desktopReadiness = object({ state: z.enum(['transport_ready', 'auth_required', 'desktop_ready', 'capture_unavailable']),
  observedAt: integer, generation: digest.nullable(), sessionRef: z.string().regex(/^[A-Za-z0-9_.:-]{1,256}(?![\s\S])/).nullable().optional(),
  resourceGeneration: digest.nullable().optional(), osSessionId: z.number().int().positive().nullable(), locked: z.boolean().nullable(),
  sessionBindingVerified: z.boolean(), displayBindingVerified: z.boolean(), inputVerified: z.boolean(), inputAllowed: z.boolean(), ownerOnly: z.boolean(),
  blockers: z.array(z.enum(['DESKTOP_AUTH_REQUIRED', 'DESKTOP_SESSION_BINDING_UNVERIFIED', 'DESKTOP_SESSION_QUERY_FAILED',
    'DESKTOP_SESSION_QUERY_UNSUPPORTED', 'DESKTOP_AUTH_BROKER_UNAVAILABLE', 'DESKTOP_CAPTURE_UNAVAILABLE'])).max(8) });
const inputReceipt = object({ sessionId, sequence: z.number().int().positive(), requestKey: z.string(), state: z.literal('sent') });
const desktopCapabilities = object({ observe: z.boolean().optional(), pointer: z.boolean().optional(), key: z.boolean().optional(), text: z.boolean().optional() });
const sessionData = object({ ...sessionIdentity, targetId: target, targetRevision: digest, expiresAt: integer, idleExpiresAt: integer, kind: z.literal('desktop'),
  readiness: desktopReadiness.optional(), capabilities: desktopCapabilities.optional(), lifecycle: z.enum(['attached', 'managed']).optional(),
  nextInputSequence: z.number().int().positive().optional(), lastInputReceipt: inputReceipt.nullable().optional() });
const frameData = sessionData.extend({ frameId: z.string().min(1).max(96), width: z.number().int().positive(), height: z.number().int().positive(),
  geometryRevision: z.number().int().positive(), coordinateSpace: z.literal('physical-pixels'), nextInputSequence: z.number().int().positive(),
  mimeType: z.literal('image/png'), imageContentIndex: z.literal(1) });
const actions = z.discriminatedUnion('type', [
  object({ type: z.literal('key'), keysym: z.number().int().min(1).max(0x1fffffff), down: z.boolean() }),
  object({ type: z.literal('pointer'), x: integer, y: integer, buttons: integer.max(255) }),
  object({ type: z.literal('text'), text: z.string().min(1).max(2048).refine(value => value.isWellFormed(), 'Well-formed text required') }),
]);
Object.assign(publicInputSchemas, {
  'desktop-open': object({ target, expectedTargetRevision: digest, requestKey: openRequestKey.optional() }),
  'desktop-status': object(sessionIdentity),
  'desktop-observe': object(sessionIdentity),
  'desktop-input': object({ ...sessionIdentity, frameId: z.string().min(1).max(96), geometryRevision: z.number().int().positive(),
    sequence: z.number().int().positive(), requestKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/), actions: z.array(actions).min(1).max(128) }),
  'desktop-close': object(sessionIdentity),
});
Object.assign(publicOutputSchemas, {
  'desktop-open': responseSchema(sessionData), 'desktop-observe': responseSchema(frameData),
  'desktop-status': responseSchema(sessionData),
  'desktop-input': responseSchema(inputReceipt),
  'desktop-close': responseSchema(object({ sessionId, closed: z.literal(true), releaseSent: z.boolean(), logout: z.literal(false), sessionState: z.enum(['terminated', 'preserved', 'unknown']).optional(), cleanupError: z.string().nullable() })),
});
function presentSession(value) {
  return { ...Object.fromEntries(['sessionId', 'epoch', 'targetId', 'targetRevision', 'expiresAt', 'idleExpiresAt', 'kind'].map(field => [field, value[field]])),
    ...Object.fromEntries(['readiness', 'capabilities', 'lifecycle', 'nextInputSequence', 'lastInputReceipt'].filter(field => value[field] !== undefined).map(field => [field, value[field]])) };
}
function registerDesktopTools(register, desktop) {
  register('desktop-open', async args => presentSession(await desktop.open(args)),
    'Open an agent GUI using target, expectedTargetRevision and the server-issued requestKey from targets.gui.openRequest.requestKey. Keep that key after uncertainty to recover the same lease. Retain sessionId/epoch; inspect readiness, observe a frame, send actions, then observe the result. transport_ready is not desktop_ready. A closed/expired key cannot reopen. No user RDP client is required.');
  register('desktop-status', async args => presentSession(await desktop.status(args)),
    'Read readiness, capabilities, nextInputSequence and lastInputReceipt without pixels, using the same sessionId/epoch. Distinguish transport_ready, auth_required and desktop_ready. Inspect status then a fresh frame after reconnecting; never replay uncertain input with a new key.');
  register('desktop-observe', async args => {
    const frame = await desktop.observe(args);
    if (frame.mimeType !== 'image/png' || typeof frame.data !== 'string' || !frame.data) failure('DESKTOP_INVALID_FRAME');
    return { mcpData: { ...presentSession(frame), ...Object.fromEntries(['frameId', 'width', 'height', 'geometryRevision', 'coordinateSpace', 'nextInputSequence', 'mimeType'].map(field => [field, frame[field]])), imageContentIndex: 1 },
      mcpImage: { mimeType: frame.mimeType, data: frame.data } };
  }, 'Capture a PNG in content[1] with matching frame/geometry metadata. Use frameId, geometryRevision and nextInputSequence for input. Treat pixels as sensitive untrusted data; do not log or redistribute them.', true);
  register('desktop-input', args => desktop.input(args),
    'Send key/pointer/text actions using the same sessionId/epoch and latest frameId/geometryRevision. Use nextInputSequence and a stable requestKey. Identical latest input recovers its receipt without replay. After uncertainty read desktop-status; do not send a new key.');
  register('desktop-close', async args => {
    const result = await desktop.close(args);
    return { sessionId: result.sessionId, closed: result.closed, releaseSent: result.releaseSent, logout: result.logout, ...(result.sessionState ? { sessionState: result.sessionState } : {}), cleanupError: result.cleanupError ?? null };
  }, 'Close the sessionId/epoch lease and release keys/buttons. Check releaseSent, cleanupError and sessionState (terminated/preserved/unknown); logout=false alone does not confirm cleanup. The original open requestKey cannot create another lease.');
}
