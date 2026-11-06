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
      instructions: 'Contract 2.0. Start with targets; use stable operationKey and exact target revision. submit accepts work; observe defaults to immediate status. For asynchronous completion background the packaged client watch with --notify-hook for your own host/session, continue other work, then consume the hook body and ACK its exact receipt/claim. Plugin registration and wake requests are not receipt evidence. The packaged portal-files client reads and transmits bytes outside the model and returns a UUID for files. One remote MCP connection is sufficient; a second local MCP server is optional. The remote server cannot read a path on the caller computer. Do not transcribe large file bytes into model tool arguments. artifact-* accepts authorized bytes already available. Preserve IDs after uncertainty; never replay unknown outcomes, expose credentials or self-approve. show-* opens optional owner UI; private ui-* is not for agents. GUI leases support agent interaction within advertised capabilities.',
    });
    registerPublicTools(server, { operations, files, opaqueFiles, settings, targets, shutdownSignal, requestSignal, admission, desktop });
    server.registerResource('SSH approval card', URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: uiHtml, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] }));
    const toolDescriptions = {
  "show-ui-probe": "Show an optional owner UI probe. Text reports availability, not proof that the host rendered a card.",
  "show-approval": "Show the owner approval card for an existing request id. Displaying a card never approves or executes it.",
  "show-file-transfer": "Show an owner file picker/download card for target and remotePath. Without card rendering, use packaged portal-files for PC bytes. This tool cannot read PC paths.",
  "ui-decide-request": "Owner UI only: approve/deny the original request with its bound ticket. Agents must not self-approve.",
  "ui-upload-begin": "Owner UI only: reserve the selected upload with its ticket, size and SHA-256.",
  "ui-upload-chunk": "Owner UI only: append the next upload chunk using its ticket and sequence.",
  "ui-upload-finish": "Owner UI only: verify and submit that upload; inspect its request for publication.",
  "ui-download-link": "Owner UI only: get the authorized download link in private metadata.",
  "ui-read-command-output": "Owner UI only: read a bounded output page for the original approval card, in private metadata."
};
    const tool = (name, schema, outputSchema, handler, { description = toolDescriptions[name], readOnly = false, appOnly = false } = {}) => server.registerTool(name, {
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
