import { readFile } from 'node:fs/promises';
import { ApprovalQueue } from './src/domain/approval-queue.mjs';
import { createCommandService } from './src/application/commands.mjs';
import { createFileService } from './src/application/files.mjs';
import { createLifecycleService } from './src/application/lifecycle.mjs';
import { Artifacts } from './src/adapters/storage/artifacts.mjs';
import { createFileSource } from './src/adapters/sources/file-source.mjs';
import { createTransferExecutor } from './src/adapters/ssh/transfers.mjs';
import { parseSettings } from './src/adapters/config/settings.mjs';
import { createAdminAccess } from './src/adapters/security/admin-access.mjs';
import { authorizeAdminRequest } from './src/adapters/security/admin-policy.mjs';
import { Tickets } from './src/adapters/security/tickets.mjs';
import { createProtocolAdapters } from './src/adapters/http/protocol.mjs';

// Preserve the original injectable createApplication callback at the composition boundary.
// Concrete runtime executors already return the neutral outcome accepted by use cases.
const commandExecutor = execute => async (profile, command) => {
  const value = await execute(profile, command);
  if (value && typeof value.failed === 'boolean' && Array.isArray(value.texts)) return value;
  return { failed: Boolean(value?.isError), texts: (value?.content ?? []).filter(x => x.type === 'text').map(x => x.text),
    ...(value?.structuredContent === undefined ? {} : { data: value.structuredContent }) };
};

/** Assemble concrete ports. Business policy belongs to application/domain modules. */
export async function createApplication({ registry, classify, executeCommand, audit, transferRoot, env = process.env, uiHtml, accessKeySet, uploadSource }) {
  const settings = parseSettings(env);
  const adminAccess = createAdminAccess(env, accessKeySet);
  const signer = new Tickets(env.BRIDGE_UI_TICKET_KEY);
  const reader = registry.getProfile(settings.readProfile), writer = registry.getProfile(settings.writeProfile);
  if (!reader.readOnly || writer.readOnly || ['host', 'port', 'user'].some(key => reader[key] !== writer[key])) throw Error('Expected matching writable and read-only SSH targets');
  const target = `${writer.user}@${writer.host}:${writer.port}`;
  const store = new Artifacts(transferRoot, { maxBytes: settings.maxBytes, budget: settings.budget });
  await store.init();
  const source = uploadSource ?? createFileSource({ hosts: settings.uploadHosts, maxBytes: settings.maxBytes });
  const bindFileSource = url => source.bind ? source.bind(url) : {
    inspect() { const policy = source.inspect(url); return { allowed: policy.allowed, sourceHost: policy.sourceHost ?? policy.hostname }; },
    open: options => source.open(url, options),
  };
  const transfers = createTransferExecutor(registry, store, { readProfile: settings.readProfile, writeProfile: settings.writeProfile });
  const execute = commandExecutor(executeCommand);
  let commands, files, protocols;
  const queue = new ApprovalQueue({ classify, target, profile: settings.writeProfile, audit,
    externalBusy: () => commands?.busy() ?? false,
    executeOperation: operation => operation.kind === 'command' ? execute(settings.writeProfile, operation.command)
      : operation.kind === 'upload' ? transfers.upload(operation) : transfers.download(operation),
    onTerminal: job => files?.onTerminal(job),
  });
  commands = createCommandService({ queue, classify, executeCommand: execute, audit, target, readProfile: settings.readProfile });
  files = createFileService({ store, queue, transfers });
  const lifecycle = createLifecycleService({ queue, store, commands, files, closeConnections: () => registry.closeAll(),
    onReap: () => protocols?.reapCapabilities() });
  const shutdown = new AbortController();
  const [webHtml, webJs] = await Promise.all([
    readFile(new URL('./web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('./web/dist/app.js', import.meta.url), 'utf8'),
  ]);
  protocols = createProtocolAdapters({ queue, commands, files, store, lifecycle, settings, signer, adminAccess,
    authorizeAdminRequest, uiHtml, webHtml, webJs, bindFileSource, shutdownSignal: shutdown.signal });
  const timer = setInterval(() => lifecycle.reap().catch(() => {}), 30_000); timer.unref();
  return { ...protocols, queue, store, transfers, enabled: settings.uiEnabled,
    close() {
      clearInterval(timer); shutdown.abort();
      return lifecycle.close(() => Promise.all([protocols.mcpHttp, protocols.adminHttp].map(server => new Promise(resolve => server.close(resolve)))));
    },
  };
}
