import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createOpaqueFilesClient, opaqueUuidValid, opaqueOperationKeyValid } from '../src/adapters/cli/opaque-files-client.mjs';
import { resolveCloudflared, cachedAccessToken } from '../src/adapters/cli/cloudflared.mjs';
import { diagnoseClient } from '../src/adapters/cli/doctor.mjs';
import { validateLocalPath } from '../src/adapters/cli/local-files.mjs';
import { validateOrigin } from '../src/adapters/config/settings.mjs';

const usage = 'SSH Approval Portal file client2.0.0 (Node.js24.2+ within major24)\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] doctor\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] upload --file ABSOLUTE_FILE --operation-key STABLE_KEY\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] status UUID\n' +
  'Upload sends PC bytes directly over owner-authenticated HTTP. Success stdout is only {"uuid":"..."}. No automatic login, install, retry, approval or SSH destination selection.\n';

export async function main(argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr,
  runCredential = execFileSync, environment = process.env, openClient = createOpaqueFilesClient, diagnose = diagnoseClient) {
  let client, result, command, failed = false;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: 'boolean' }, origin: { type: 'string' }, cloudflared: { type: 'string' }, file: { type: 'string' }, 'operation-key': { type: 'string' },
    } });
    if (values.help === true && argv.length === 1) { output.write(usage); return 0; }
    command = positionals[0];
    if (values.help || !values.origin || !['doctor', 'upload', 'status'].includes(command) ||
        positionals.length !== (command === 'status' ? 2 : 1) ||
        (command === 'upload' ? !values.file || !values['operation-key'] : values.file !== undefined || values['operation-key'] !== undefined)) throw Object.assign(Error(), { code: 'INVALID_ARGUMENTS' });
    validateOrigin(values.origin);
    if (values.cloudflared !== undefined) validateLocalPath(values.cloudflared);
    if (command === 'status' && !opaqueUuidValid(positionals[1])) throw Object.assign(Error(), { code: 'INVALID_ARTIFACT_UUID' });
    if (command === 'upload') {
      validateLocalPath(values.file);
      if (!opaqueOperationKeyValid(values['operation-key'])) throw Object.assign(Error(), { code: 'INVALID_OPERATION_KEY' });
    }
    if (command === 'doctor') {
      result = await diagnose({ origin: values.origin, cloudflared: values.cloudflared, env: environment, runCredential });
      if (result.state === 'ready') result.next = 'Use portal-files upload --file ABSOLUTE_FILE --operation-key STABLE_KEY. Keep the completed UUID for the existing remote MCP connection; uncertain uploads must be observed by the same UUID, without creating a replacement.';
      output.write(JSON.stringify(result) + '\n');
      return result.state === 'ready' ? 0 : 1;
    }
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || minor < 2) throw Object.assign(Error(), { code: 'UNSUPPORTED_NODE_VERSION' });
    const helper = await resolveCloudflared({ explicit: values.cloudflared, env: environment });
    const token = cachedAccessToken(helper.path, values.origin, runCredential);
    client = openClient({ origin: values.origin, accessToken: token });
    await client.connect();
    result = command === 'status' ? await client.status(positionals[1]) : await client.upload(values.file, values['operation-key'],
      progress => errorOutput.write(JSON.stringify({ uuid: progress.uuid, phase: 'staging' }) + '\n'));
    if (command === 'upload' && (!result || !opaqueUuidValid(result.uuid) || Object.keys(result).length !== 1)) throw Object.assign(Error(), { code: 'INVALID_ARTIFACT_RESPONSE' });
  } catch (error) {
    failed = true;
    const record = { error: /^[A-Z_]{3,64}$/.test(error.code ?? '') ? error.code : 'CLI_REQUEST_FAILED' };
    if (opaqueUuidValid(error.uuid)) record.uuid = error.uuid;
    if (['snapshot', 'begin', 'chunks', 'complete'].includes(error.phase)) record.phase = error.phase;
    if (error.progress) for (const field of ['state', 'received', 'sequence']) record[field] = error.progress[field];
    errorOutput.write(JSON.stringify(record) + '\n');
  } finally {
    try { await client?.close(); }
    catch { errorOutput.write(JSON.stringify({ error: 'OWNER_SESSION_CLEANUP_UNKNOWN', ...(opaqueUuidValid(result?.uuid) ? { uuid: result.uuid } : {}) }) + '\n'); }
  }
  if (failed) return 1;
  output.write(JSON.stringify(result) + '\n');
  return 0;
}

const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (invoked && pathToFileURL(invoked).href === import.meta.url) process.exitCode = await main();
