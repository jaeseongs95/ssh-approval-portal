import { z } from 'zod';

const identifier = z.string().regex(/^[a-f0-9]{48}$/);
const state = z.enum(['pending', 'evaluating', 'running', 'completed', 'failed', 'denied', 'expired', 'unknown']);
const content = z.array(z.object({ type: z.literal('text'), text: z.string() }));
const outcome = z.object({ failed: z.boolean(), texts: z.array(z.string()), data: z.object({}).passthrough().optional() });
const legacyOutcome = z.object({ content, isError: z.boolean().optional(), structuredContent: z.object({}).passthrough().optional() }).passthrough();
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: z.string() }).passthrough(),
  z.object({ kind: z.literal('upload'), artifactId: identifier, remotePath: z.string(), fileName: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), overwrite: z.boolean(), elevate: z.boolean() }).passthrough(),
  z.object({ kind: z.literal('download'), remotePath: z.string(), elevate: z.boolean() }).passthrough(),
]);
const jobFields = {
  id: identifier, kind: z.enum(['command', 'upload', 'download']), operation,
  command: z.string().optional(), profile: z.string(), commandClass: z.string(), target: z.string(), state,
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
  targets: z.object({ targets: z.array(z.object({ id: targetId, displayName: z.string(), enabled: z.boolean(), isDefault: z.boolean() })), defaultTarget: targetId.nullable() }),
  probe: z.object({ probe: z.literal('SSH_UI_PUBLIC_PROBE'), uiEnabled: z.boolean() }),
  safety: z.object({ id: identifier, subject: z.string().regex(/^[a-f0-9]{64}$/), targetId,
    targetRevision: z.string().optional(), advisory: z.literal(true), automaticExecutionEnabled: z.literal(false),
    assessment: z.object({ status: z.enum(['assessed', 'unavailable']) }).passthrough() }),
};

export function presentOutcome(value) {
  outcome.parse(value);
  return { content: value.texts.map(text => ({ type: 'text', text })), ...(value.failed ? { isError: true } : {}), ...(value.data !== undefined ? { structuredContent: value.data } : {}) };
}

export function presentJob(job) {
  const value = { id: job.id, kind: job.kind, operation: { ...job.operation }, command: job.command,
    ...(job.targetId === undefined ? {} : { targetId: job.targetId, targetRevision: job.targetRevision, targetDisplayName: job.targetDisplayName, hostKey: job.hostKey }),
    ...(job.decision ? { decision: structuredClone(job.decision) } : {}), profile: job.profile, commandClass: job.commandClass, target: job.target, state: job.state,
    createdAt: job.createdAt, expiresAt: job.expiresAt, finishedAt: job.finishedAt,
    result: job.result === undefined ? undefined : presentOutcome(job.result), auditError: job.auditError };
  jobSchema.parse(value);
  return value;
}

export function publicResult(value, schema) {
  schema.parse(value);
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export const jobResult = job => publicResult(presentJob(job), jobSchema);
export const statusResult = job => job ? jobResult(job) : publicResult({ error: 'Unknown request; server may have restarted' }, unknownSchema);
export function immediateResult(value, identity) {
  return { ...presentOutcome(value), structuredContent: { state: value.failed ? 'failed' : 'completed', kind: 'command', ...identity } };
}
export const sourceUnavailable = sourceHost => ({ ...publicResult({ error: 'upload-source-not-configured', sourceHost,
  message: 'File was not fetched or queued. An administrator must configure a verified exact hostname or *.domain pattern for this provider; the card file picker remains available.' }, sourceUnavailableSchema), isError: true });
export const refused = () => ({ isError: true, content: [{ type: 'text', text: 'Request refused or failed. Check authentication, state, limits and permissions.' }] });
