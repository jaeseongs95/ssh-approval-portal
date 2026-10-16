import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { posix } from 'node:path';
import { hash, remotePath } from '../../domain/validation.mjs';
import { CHUNK_BYTES } from '../../contracts/ports.mjs';
import { outputSchemas, publicResult, jobResult, statusResult, immediateResult, sourceUnavailable, refused } from '../presentation/results.mjs';

const id = z.string().regex(/^[a-f0-9]{48}$/), ticket = z.string().min(1).max(8192);
function decodeChunk(data) {
  if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('Invalid chunk');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== data) throw Error('Invalid chunk');
  return bytes;
}

export function createMcpAdapter({ queue, commands, files, settings, capabilities, uiHtml, bindFileSource, shutdownSignal }) {
  const URI = `ui://ssh-approval/card-${hash(uiHtml)}.html`;
  return function mcpServer(requestSignal) {
    const server = new McpServer({ name: 'SSH Approval Portal', version: '1.0.0' });
    server.registerResource('SSH approval card', URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: uiHtml, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] }));
    const tool = (name, schema, outputSchema, handler, { ui = false, appOnly = false, description = name, readOnly = false, meta, openWorld = false } = {}) => server.registerTool(name, {
      description, inputSchema: schema, outputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, ...(openWorld ? { openWorldHint: true } : {}) },
      _meta: (ui || appOnly || meta) ? { ...meta, ...((ui || appOnly) ? { ui: { ...(ui ? { resourceUri: URI } : {}), visibility: appOnly ? ['app'] : ['model', 'app'] } } : {}) } : undefined,
    }, async (args, extra) => {
      try { return await handler(args, { ...extra, signal: AbortSignal.any([shutdownSignal, requestSignal, extra?.signal].filter(Boolean)) }); }
      catch { return refused(); }
    });
    tool('read-command', { command: z.string().min(1).max(2000) }, outputSchemas.immediate, async ({ command }) => immediateResult(await commands.read(command)), { readOnly: true, description: 'Execute proven read-only commands immediately.' });
    tool('run-command', { command: z.string().min(1).max(2000) }, outputSchemas.run, async ({ command }) => {
      const result = await commands.run(command);
      if (result.type === 'immediate') return immediateResult(result.outcome);
      if (result.type !== 'job') throw Error('Invalid command result');
      return jobResult(result.job);
    }, { description: 'Run read-only immediately; queue all other commands for approval. If pending, call show-approval with its id to show the owner the approval card.' });
    tool('request-safe-command', { command: z.string().min(1).max(2000) }, outputSchemas.job, ({ command }) => jobResult(queue.submit(command, true)), { description: 'Legacy safe-only owner approval request.' });
    tool('get-request-status', { id }, outputSchemas.status, ({ id }) => statusResult(queue.get(id)), { readOnly: true });
    tool('request-upload', {
      file: z.object({ download_url: z.string().min(1).max(16384), file_id: z.string().min(1).max(1024), mime_type: z.string().max(255).optional(), file_name: z.string().max(255).optional() }).strict(),
      remotePath: z.string().max(4096), overwrite: z.boolean().default(false), elevate: z.boolean().default(false),
    }, outputSchemas.upload, async ({ file, remotePath: path, overwrite, elevate }, { signal }) => {
      const result = await files.requestUpload({ source: bindFileSource(file.download_url), fileName: file.file_name ?? posix.basename(path), remotePath: path, overwrite, elevate }, { signal });
      if (result.type === 'source-unavailable') return sourceUnavailable(result.sourceHost);
      if (result.type !== 'job') throw Error('Invalid upload result');
      return { ...jobResult(result.job), _meta: { sshApproval: capabilities.view(result.job) } };
    }, { ui: true, openWorld: true, meta: { 'openai/fileParams': ['file'] },
      description: 'Stage a ChatGPT/OpenAI fileParams authorized file (download_url and file_id) and queue owner approval. Automatic file inputs currently support only that host contract. If another host supplies only an opaque file_uuid or cannot supply this input, use show-file-transfer and its file picker; never invent a URL, pass cookies or file bytes. No remote file is written before owner approval. A source-not-configured result reports only the hostname; an administrator can configure verified exact hostnames or leading *.domain patterns.' });
    tool('show-ui-probe', {}, outputSchemas.probe, () => ({ ...publicResult({ probe: 'SSH_UI_PUBLIC_PROBE', uiEnabled: settings.uiEnabled }, outputSchemas.probe), _meta: { sshApproval: { privateMarker: 'SSH_UI_PRIVATE_PROBE_NOT_FOR_MODEL', uiEnabled: false, namespace: settings.prefix, webUrl: settings.adminOrigin } } }), { ui: true, readOnly: true, description: 'Display a harmless UI compatibility probe. No command, approval ticket or file data.' });
    tool('show-approval', { id }, outputSchemas.job, ({ id }) => {
      const job = queue.get(id); if (!job) throw Error('Unknown request');
      return { ...jobResult(job), _meta: { sshApproval: capabilities.view(job) } };
    }, { ui: true, readOnly: true });
    tool('show-file-transfer', { direction: z.enum(['upload', 'download']), remotePath: z.string().max(4096), elevate: z.boolean().default(false), overwrite: z.boolean().default(false) }, outputSchemas.transfer, args => {
      remotePath(args.remotePath);
      return { ...publicResult({ transfer: args, uiEnabled: settings.uiEnabled, maxBytes: settings.maxBytes }, outputSchemas.transfer), _meta: { sshApproval: { uiEnabled: settings.uiEnabled, namespace: settings.prefix, maxBytes: settings.maxBytes, chunkBytes: CHUNK_BYTES, webUrl: settings.adminOrigin, ...(settings.uiEnabled ? { bootstrapTicket: capabilities.bootstrap(args) } : {}) } } };
    }, { ui: true, readOnly: true });
    tool('request-download', { remotePath: z.string().max(4096), elevate: z.boolean().default(false) }, outputSchemas.job, args => jobResult(files.requestDownload(args)), { description: 'Read a regular remote file, or queue a sudo download. Call show-approval for the returned id to display status and save button.' });
    tool('ui-decide-request', { id, action: z.enum(['approve', 'deny']), ticket }, outputSchemas.job, ({ id, action, ticket }) => {
      capabilities.guard(); capabilities.verifyJob(id, ticket, 'decision');
      const job = action === 'approve' ? queue.start(id) : queue.deny(id);
      return { ...jobResult(job), _meta: { sshApproval: capabilities.view(job) } };
    }, { appOnly: true });
    tool('ui-upload-begin', { transfer: z.object({ direction: z.literal('upload'), remotePath: z.string().max(4096), elevate: z.boolean(), overwrite: z.boolean() }), ticket, fileName: z.string().max(255), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }, outputSchemas.begin, async ({ transfer, ticket, ...meta }) => {
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
    return server;
  };
}
