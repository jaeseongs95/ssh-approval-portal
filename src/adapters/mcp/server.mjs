import metadata from '../../../package.json' with { type: 'json' };
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hash, remotePath, windowsRemotePath } from '../../domain/validation.mjs';
import { platformOf } from '../../domain/target-platform.mjs';
import { CHUNK_BYTES, OUTPUT_PAGE_BYTES } from '../../contracts/ports.mjs';
import { outputSchemas, publicResult, jobResult, refused } from '../presentation/results.mjs';
import { registerPublicTools, decodeArtifactChunk } from './public-contract.mjs';

const target = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional();
const id = z.string().regex(/^[a-f0-9]{48}$/), ticket = z.string().min(1).max(8192);
const decodeChunk = decodeArtifactChunk;

export function createMcpAdapter({ queue, files, opaqueFiles, settings, capabilities, uiHtml, shutdownSignal, targets, commandOutputs, operations, desktop }) {
  const URI = `ui://ssh-approval/card-${hash(uiHtml)}.html`;
  return function mcpServer(requestSignal, admission) {
    const server = new McpServer({ name: 'SSH Approval Portal', version: metadata.version }, {
      // Seven desktop-input members plus 128 pointer actions (one array slot + four members each).
      maxToolInputElements: 7 + 128 * 5,
      instructions: 'Contract 2.0. Start with targets. Submit native JSON operations using a stable operationKey, then observe the same ID or key. To keep working while a request runs, launch the packaged portal-files client watch REQUEST_ID through the host background-process facility and continue independent work. The client waits outside the model and emits one terminal event; consume the host process completion, then observe the same ID with includeOutput=true if output is needed. Do not repeatedly poll from the model or await watch in a foreground shell. Hosts without background completion delivery require an explicit later status check; do not promise automatic resumption. Owner approval and server policy remain authoritative. Observe includes output only when includeOutput=true; its wait timeout does not stop execution. For local files, the packaged portal-files client reads and transmits bytes outside the model and returns a UUID; use files to copy or move that staged UUID to a target. One remote MCP connection is sufficient; a second local MCP server is optional. This remote server cannot read a path on the caller computer. Do not transcribe large file bytes into model tool arguments. For authorized bytes already available to the caller, artifact-begin/chunk/status/finish remain available; downloads use submit(kind=download)/artifact-read or the packaged client. Shell-based transfer is not categorically prohibited; exact encoding, escaping, approval and server policy still apply. Never expose credentials, self-approve, or replay an unknown outcome. show-* tools display optional owner UI cards. Only ui-* tools are private owner UI actions. Desktop support is available only when explicitly reported and connected.',
    });
    registerPublicTools(server, { operations, files, opaqueFiles, settings, targets, shutdownSignal, requestSignal, admission, desktop });
    server.registerResource('SSH approval card', URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: uiHtml, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] }));
    const tool = (name, schema, outputSchema, handler, { description = name, readOnly = false, appOnly = false } = {}) => server.registerTool(name, {
      description, inputSchema: z.object(schema).strict(), outputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
      _meta: { ui: appOnly ? { visibility: ['app'] } : { resourceUri: URI, visibility: ['model', 'app'] } },
    }, async (args, extra) => {
      try { return await handler(args, { ...extra, signal: AbortSignal.any([shutdownSignal, requestSignal, extra?.signal].filter(Boolean)) }); }
      catch (error) { return refused(error); }
    });
    tool('show-ui-probe', {}, outputSchemas.probe, () => ({ ...publicResult({ probe: 'SSH_UI_PUBLIC_PROBE', uiEnabled: settings.uiEnabled }, outputSchemas.probe), _meta: { sshApproval: { bridgeDisplayName: settings.bridgeDisplayName, targetDisplayName: settings.targetDisplayName, privateMarker: 'SSH_UI_PRIVATE_PROBE_NOT_FOR_MODEL', uiEnabled: false, namespace: settings.prefix, webUrl: settings.adminOrigin } } }), { readOnly: true });
    tool('show-approval', { id }, outputSchemas.job, ({ id }) => {
      const job = queue.get(id); if (!job) throw Error('Unknown request');
      return { ...jobResult(job), _meta: { sshApproval: capabilities.view(job) } };
    }, { readOnly: true });
    const transfer = z.object({ target, direction: z.enum(['upload', 'download']), remotePath: z.string().max(4096), elevate: z.boolean(), overwrite: z.boolean() }).strict();
    const transferOutput = z.object({ transfer, uiEnabled: z.boolean(), maxBytes: z.number().int().positive() }).strict();
    tool('show-file-transfer', { target, direction: z.enum(['upload', 'download']), remotePath: z.string().max(4096), elevate: z.boolean().default(false), overwrite: z.boolean().default(false) }, transferOutput, args => {
      (platformOf(targets?.select(args.target)) === 'windows' ? windowsRemotePath : remotePath)(args.remotePath);
      args = targets?.canonicalTransfer(args) ?? args;
      const selected = targets?.select(args.target);
      return { ...publicResult({ transfer: args, uiEnabled: settings.uiEnabled, maxBytes: settings.maxBytes }, transferOutput), _meta: { sshApproval: {
        bridgeDisplayName: settings.bridgeDisplayName, targetDisplayName: selected?.displayName ?? settings.targetDisplayName,
        ...(selected ? { targetId: selected.id, targetRevision: selected.revision, targets: targets.list().targets } : {}),
        uiEnabled: settings.uiEnabled, namespace: settings.prefix, maxBytes: settings.maxBytes, chunkBytes: CHUNK_BYTES, webUrl: settings.adminOrigin,
        ...(settings.uiEnabled ? { bootstrapTicket: capabilities.bootstrap(args) } : {}),
      } } };
    }, { readOnly: true });
    tool('ui-decide-request', { id, action: z.enum(['approve', 'deny']), ticket }, outputSchemas.job, ({ id, action, ticket }) => {
      capabilities.guard(); capabilities.verifyJob(id, ticket, 'decision');
      const job = action === 'approve' ? queue.start(id) : queue.deny(id);
      return { ...jobResult(job), _meta: { sshApproval: capabilities.view(job) } };
    }, { appOnly: true });
    tool('ui-upload-begin', { transfer: z.object({ target, direction: z.literal('upload'), remotePath: z.string().max(4096), elevate: z.boolean(), overwrite: z.boolean() }), ticket, fileName: z.string().max(255), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }, outputSchemas.begin, async ({ transfer, ticket, ...meta }) => {
      capabilities.guard(); capabilities.verifyBootstrap(transfer, ticket);
      const item = await files.beginUpload({ ...transfer, ...meta });
      return { ...publicResult({ transferId: item.id, received: 0 }, outputSchemas.begin), _meta: { sshApproval: { uploadTicket: capabilities.upload(item) } } };
    }, { appOnly: true });
    tool('ui-upload-chunk', { id, ticket, sequence: z.number().int().nonnegative(), data: z.string().max(Math.ceil(CHUNK_BYTES / 3) * 4) }, outputSchemas.chunk, async ({ id, ticket, sequence, data }) => {
      capabilities.guard(); capabilities.verifyUpload(id, ticket);
      return publicResult(await files.appendUpload({ id, sequence, bytes: decodeChunk(data) }), outputSchemas.chunk);
    }, { appOnly: true });
    tool('ui-upload-finish', { id, ticket }, outputSchemas.job, async ({ id, ticket }) => {
      capabilities.guard(); capabilities.verifyUpload(id, ticket);
      const job = await files.finishUpload(id);
      return { ...jobResult(job), _meta: { sshApproval: capabilities.view(job) } };
    }, { appOnly: true });
    tool('ui-download-link', { id, ticket }, outputSchemas.ready, ({ id, ticket }) => {
      capabilities.guard(); capabilities.verifyJob(id, ticket, 'view');
      const job = queue.get(id), downloadUrl = capabilities.downloadLink(job), fileName = job.result.data.fileName;
      return { ...publicResult({ ready: true, fileName }, outputSchemas.ready), _meta: { sshApproval: { downloadUrl, fileName } } };
    }, { appOnly: true, readOnly: true });
    const range = { outputId: id, target, offsetBytes: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(4).max(OUTPUT_PAGE_BYTES).default(4096), format: z.enum(['text', 'json']).default('text') };
    const pageSchema = z.object({ outputId: id, bytes: z.number(), nextOffset: z.number(), eof: z.boolean() }).passthrough();
    tool('ui-read-command-output', { ...range, id, ticket }, pageSchema, ({ id, ticket, ...args }) => {
      capabilities.guard(); capabilities.verifyJob(id, ticket, 'view');
      const job = queue.get(id);
      if (job?.kind !== 'command' || job.result?.output?.id !== args.outputId) throw Error('Original request output required');
      const { text, ...metadata } = commandOutputs.read(args);
      return { content: [], structuredContent: metadata, _meta: { sshOutput: { text } } };
    }, { appOnly: true, readOnly: true, description: 'Load a bounded output page for the original approval card. Body stays in private UI metadata.' });
    return server;
  };
}
