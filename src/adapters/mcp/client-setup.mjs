import { z } from 'zod';
import { MAX_BYTES, CHUNK_BYTES } from '../../contracts/ports.mjs';

const clientSchema = z.object({
  fileBytes: z.boolean().default(false),
  localProcess: z.boolean().default(false),
  localStdio: z.boolean().default(false),
  hostFileInput: z.boolean().default(false),
  ui: z.boolean().default(false),
}).strict();

export const clientSetupInputSchema = z.object({ client: clientSchema.default({ fileBytes: false, localProcess: false, localStdio: false, hostFileInput: false, ui: false }) }).strict();
const guidance = z.string().min(1).max(2048);
const coreTool = z.enum(['list-targets', 'run-command', 'run-python-source', 'get-request-status', 'wait-for-request', 'read-command-output']);
// Whole-array enum preserves tuple order in both draft-07 and 2020-12 schemas.
const fixedStringArray = values => z.array(z.enum(values)).length(values.length)
  .refine(items => items.every((item, index) => item === values[index]), 'Expected the exact ordered values')
  .meta({ enum: [values] });
export const clientSetupOutputSchema = z.object({
  contract: z.literal('agent-client-setup-v1'),
  client: clientSchema,
  recommendedRoute: z.enum(['remote-mcp', 'local-cli', 'local-stdio', 'host-file-input', 'owner-ui', 'unavailable']),
  localReadiness: z.enum(['not-required', 'requires-local-check']),
  serverUi: z.object({ enabled: z.boolean(), clientRenderingVerified: z.literal(false) }).strict(),
  core: z.object({ uiRequired: z.literal(false), tools: z.array(coreTool).min(1).max(6), guidance }).strict(),
  local: z.object({
    doctor: z.object({ executable: z.literal('node'), argv: z.array(z.string().min(1).max(4096)).length(4),
      optionalArgs: fixedStringArray(['--cloudflared', '<existing absolute executable>']),
      cwd: z.literal('<trusted package root>') }).strict(),
    prerequisites: z.array(guidance).min(1).max(5),
    cloudflared: z.object({ precedence: fixedStringArray(['--cloudflared', 'PORTAL_CLOUDFLARED', 'PATH']), guidance }).strict(),
  }).strict(),
  fileTransport: z.object({
    contract: z.literal('mcp-json-upload-v1'),
    tools: fixedStringArray(['begin-upload', 'upload-chunk', 'get-upload-status', 'finish-upload']),
    maxBytes: z.number().int().min(1).max(MAX_BYTES), maxChunkBytes: z.literal(CHUNK_BYTES), encoding: z.literal('base64'),
    additionalInstallationRequired: z.literal(false), requiresClientFileBytes: z.literal(true), guidance,
  }).strict(),
  approvals: z.object({ adminUrl: z.string().url().max(4096), ownerRequiredByPolicy: z.literal(true), agentSelfApproval: z.literal(false), guidance }).strict(),
  limitations: z.array(guidance).min(1).max(5),
  documentation: z.literal('docs/agent-clients.ko.md'),
}).strict();

const routeGuidance = {
  'remote-mcp': 'The caller reports authorized file-byte access through an existing tool. Use the remote standard MCP upload tools. No local CLI, stdio server, package installation or cloudflared is required. The server does not read client paths; read actual bytes through the authorized file tool, never infer them from a path or opaque file ID.',
  'local-cli': 'The caller reports local process access. Before using scripts/portal-client.mjs upload, request-download, status or save, verify the execution host and file host match or the owner has confirmed a safe mapping, resolve the trusted package root, and check authorized file access, package installation and owner authentication. Local process access alone does not prove access to user PC paths or local readiness.',
  'local-stdio': 'The caller reports local stdio MCP support. Verify the execution host and file host match or the owner has confirmed a safe mapping before treating user PC paths as accessible. The owner must configure scripts/portal-file-mcp.mjs with a manifest of authorized file IDs and a dedicated journal. Use file_capabilities, file_upload, file_download_request, file_status and file_save; remote command tools remain on the remote MCP server.',
  'host-file-input': 'The caller reports the openai/fileParams host file-input contract. Use request-upload only with a real authorized host-provided download_url and file_id and an administrator-configured source hostname. This contract does not imply local PC file access or a download-save transport.',
  'owner-ui': 'The caller reports a user interface. The owner can use the existing administrator page for file transfer and required approval; an MCP Apps card additionally requires server UI enablement and actual client rendering support. Do not treat serverUi.enabled as proof that a card rendered.',
  unavailable: 'No file transport was reported. First check whether an existing authorized file tool can read actual source bytes and report fileBytes=true to use remote MCP upload without installing local software. Otherwise check authorized local process access or local stdio support, or ask the owner to use the existing administrator page. Do not infer abilities from the AI product name, a path, an opaque file ID or a missing card.',
};
const remoteUploadGuidance = 'Remote MCP upload is available whenever an existing authorized tool can read actual file bytes; report fileBytes=true to select it. begin-upload requires target, its current expectedTargetRevision (64 lowercase hex characters), fileName, size, full-file sha256 and remotePath; overwrite and elevate default to false. Respect maxBytes (at most 64 MiB). upload-chunk takes id, sequence and canonical base64 data of at most maxChunkBytes decoded bytes. Preserve the upload ID and use get-upload-status with the SAME ID after interruption before explicit resume. finish-upload verifies the complete SHA-256 before submitting the file; a duplicate finish is safely refused, then retrieve the original result by the same status ID. REMOTE_UPLOAD_* codes distinguish safe failure categories without exposing private exception text; an uncertain finish does not prove non-execution. Never automatically replay begin, chunks or finish, replace an uncertain operation with a new ID, or bypass server policy and owner approval. Recovery requires the same bridge process and a retained queue record; restart can lose staging and submitted file requests. Missing results never authorize automatic resubmission. Local CLI and stdio are optional alternatives for efficient large-file transfer.';

// Pure guidance only: the remote server cannot inspect the caller's PC or authenticate it.
export function clientSetup(input, settings) {
  const { client } = clientSetupInputSchema.parse(input);
  const recommendedRoute = client.fileBytes ? 'remote-mcp' : client.localProcess ? 'local-cli' : client.localStdio ? 'local-stdio'
    : client.hostFileInput ? 'host-file-input' : client.ui ? 'owner-ui' : 'unavailable';
  return clientSetupOutputSchema.parse({
    contract: 'agent-client-setup-v1', client, recommendedRoute, localReadiness: client.fileBytes ? 'not-required' : 'requires-local-check',
    serverUi: { enabled: settings.uiEnabled, clientRenderingVerified: false },
    core: { uiRequired: false, tools: ['list-targets', 'run-command', 'run-python-source', 'get-request-status', 'wait-for-request', 'read-command-output'],
      guidance: 'Core requests, status, approval waiting and output reads use standard MCP JSON inputs and text results without cards. Check list-targets, submit the authorized exact request under server policy, retain its ID, present pending approval on the existing administrator page, wait-for-request with the SAME ID, and read-command-output by returned offsets. Read content text if structuredContent is unavailable. Timeout, missing, unknown, failed or expired results never authorize automatic replay or resubmission.' },
    local: {
      doctor: { executable: 'node', argv: ['scripts/portal-client.mjs', '--origin', settings.adminOrigin, 'doctor'],
        optionalArgs: ['--cloudflared', '<existing absolute executable>'], cwd: '<trusted package root>' },
      prerequisites: [
        '<trusted package root> is an unresolved placeholder, not a verified installation path. Resolve the location from existing owner-provided setup or a registered local tool, then verify the actual trusted package root, scripts/portal-client.mjs, required Node.js version and dependencies before executing the argv template. If the location is unknown, stop this local step as CLI_LOCATION_UNKNOWN and ask the owner only for the existing package location; do not infer that it is uninstalled or automatically install it.',
        'These local prerequisites apply only if the optional local CLI or stdio path is chosen. Remote MCP upload with existing authorized file-byte access requires no local package, CLI, stdio registration or cloudflared.',
        'The optional local owner CLI and stdio use Cloudflare Access. Existing owner authentication must be checked locally; interactive login belongs to the owner. Do not copy credentials or authentication tokens into model context.',
        'If using the optional local path, run doctor locally before transfer to check readiness. It does not submit SSH execution, transfer files, approve requests or prove an untested end-to-end operation.',
      ],
      cloudflared: { precedence: ['--cloudflared', 'PORTAL_CLOUDFLARED', 'PATH'],
        guidance: 'Resolve the exact executable in this order: explicit --cloudflared absolute path, PORTAL_CLOUDFLARED absolute path, then exact cloudflared executable names on PATH. A portable installation outside PATH needs an explicit flag or environment setting. A PATH miss does not prove cloudflared is uninstalled. Do not recursively search disks or execute a similarly named program. Append the optional --cloudflared argument pair to doctor only after locating an existing absolute executable; otherwise let environment/PATH discovery run.' },
    },
    fileTransport: { contract: 'mcp-json-upload-v1', tools: ['begin-upload', 'upload-chunk', 'get-upload-status', 'finish-upload'],
      maxBytes: Math.min(settings.maxBytes ?? MAX_BYTES, MAX_BYTES), maxChunkBytes: CHUNK_BYTES, encoding: 'base64',
      additionalInstallationRequired: false, requiresClientFileBytes: true, guidance: routeGuidance[recommendedRoute] + ' ' + remoteUploadGuidance },
    approvals: { adminUrl: settings.adminOrigin, ownerRequiredByPolicy: true, agentSelfApproval: false,
      guidance: 'Use only the existing administrator page and returned request ID for owner review when policy requires it. This setup tool issues no approval link or token. Never call owner approval commands or private ui-* tools to self-approve; never automatically approve or replay a request.' },
    limitations: [
      'Client flags are caller-reported abilities, not verified availability. Missing flags default to false and do not prove that a capability is impossible.',
      'The remote MCP server cannot inspect client package installation, local executable discovery, authentication cache, local file permissions or UI rendering.',
      'Never invent file URLs or treat opaque file IDs and server-side paths as PC file bytes. Never place file bytes in shell commands or copy credentials to bypass a missing file transport.',
      'Before executing against or transferring a user PC path, verify the agent execution host and file host match or the owner has confirmed a safe mapping. WSL, containers and remote development can execute on a different host or filesystem. Local process or stdio support alone does not establish this condition; do not invent path conversions or infer access.',
    ],
    documentation: 'docs/agent-clients.ko.md',
  });
}
