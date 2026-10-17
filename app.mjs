import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ApprovalQueue } from './src/domain/approval-queue.mjs';
import { createCommandService } from './src/application/commands.mjs';
import { createFileService } from './src/application/files.mjs';
import { createLifecycleService } from './src/application/lifecycle.mjs';
import { resolveTargets } from './src/adapters/config/targets.mjs';
import { scopedArtifacts } from './src/adapters/storage/scoped-artifacts.mjs';
import { createClaims, createTargetRouter } from './src/application/target-router.mjs';
import { Artifacts } from './src/adapters/storage/artifacts.mjs';
import { createFileSource } from './src/adapters/sources/file-source.mjs';
import { createTransferExecutor } from './src/adapters/ssh/transfers.mjs';
import { parseSettings } from './src/adapters/config/settings.mjs';
import { createAdminAccess } from './src/adapters/security/admin-access.mjs';
import { authorizeAdminRequest } from './src/adapters/security/admin-policy.mjs';
import { Tickets } from './src/adapters/security/tickets.mjs';
import { createProtocolAdapters } from './src/adapters/http/protocol.mjs';
import { createJevAssessor } from './src/adapters/safety/jev.mjs';
import { createRequestSafety } from './src/application/request-safety.mjs';
import { createSecretService } from './src/application/secret-service.mjs';
import { createLocalSecretStore } from './src/adapters/secrets/local-file.mjs';
import { createCommandState } from './src/adapters/storage/command-state.mjs';
import { createCommandAutomation } from './src/application/command-automation.mjs';
import { AUTOMATION_QUESTION, AUTOMATION_QUESTION_VERSION, COMMAND_SET_QUESTION } from './src/domain/command-policy.mjs';
import { createCommandPolicyReview } from './src/application/command-policy-review.mjs';

// Preserve the original injectable createApplication callback at the composition boundary.
// Concrete runtime executors already return the neutral outcome accepted by use cases.
const commandExecutor = execute => async (profile, command) => {
  const value = await execute(profile, command);
  if (value && typeof value.failed === 'boolean' && Array.isArray(value.texts)) return value;
  return { failed: Boolean(value?.isError), texts: (value?.content ?? []).filter(x => x.type === 'text').map(x => x.text),
    ...(value?.structuredContent === undefined ? {} : { data: value.structuredContent }) };
};

/** Assemble concrete ports. Business policy belongs to application/domain modules. */
export async function createApplication({ registry, classify, executeCommand, audit, transferRoot, env = process.env, uiHtml, accessKeySet, uploadSource, riskAssessor, policyRiskAssessor, secretResolver, riskEvaluators = {} }) {
  const settings = parseSettings(env);
  const adminAccess = createAdminAccess(env, accessKeySet);
  const signer = new Tickets(env.BRIDGE_UI_TICKET_KEY);
  const definitions = resolveTargets(settings, registry);
  const store = new Artifacts(transferRoot, { maxBytes: settings.maxBytes, budget: settings.budget });
  await store.init();
  let risk = riskAssessor, apiKey;
  if (settings.jevEnabled) {
    apiKey = env.JEV_API_KEY;
    if (!apiKey && settings.jevKeyRef) {
      const resolver = secretResolver ?? createSecretService(settings.secretStoreDir
        ? { 'local-file': createLocalSecretStore(settings.secretStoreDir) } : {});
      try { apiKey = await resolver.resolve(settings.jevKeyRef); } catch { /* Missing keys grant no authority. */ }
    }
    risk ??= createJevAssessor({ apiKey });
  }
  const commandState = settings.commandAutomation ? createCommandState(transferRoot) : undefined;
  const evaluators = { ...riskEvaluators };
  const automationBudget = { used: 0 };
  if (settings.jevEnabled && !evaluators.jev) evaluators.jev = { model: 'jev-1.13.0', questionVersion: AUTOMATION_QUESTION_VERSION, ...createJevAssessor({ apiKey, question: AUTOMATION_QUESTION, inputKind: 'execution' }) };
  const source = uploadSource ?? createFileSource({ hosts: settings.uploadHosts, maxBytes: settings.maxBytes });
  const bindFileSource = url => source.bind ? source.bind(url) : {
    inspect() { const policy = source.inspect(url); return { allowed: policy.allowed, sourceHost: policy.sourceHost ?? policy.hostname }; },
    open: options => source.open(url, options),
  };
  const execute = commandExecutor(executeCommand), claimExecution = createClaims(2), claimImport = createClaims(2);
  const runtimes = definitions.map(definition => {
    const { target, readProfile, writeProfile, identity } = definition;
    const targetStore = identity ? scopedArtifacts(store, identity) : store;
    const checkedRegistry = { getOrCreate(profile) { definition.verify(); return registry.getOrCreate(profile); } };
    const transfers = createTransferExecutor(checkedRegistry, targetStore, { readProfile, writeProfile });
    const checkedExecute = (profile, command) => { definition.verify(); return execute(profile, command); };
    const targetAudit = event => audit({ ...event, ...identity });
    let commands, files;
    const queue = new ApprovalQueue({ classify, target, profile: writeProfile, audit: targetAudit, identity, claimExecution,
      externalBusy: () => (commands?.reading() ?? false) || claimExecution.busy(),
      executeOperation: operation => operation.kind === 'command' ? checkedExecute(writeProfile, operation.command)
        : operation.kind === 'upload' ? transfers.upload(operation) : transfers.download(operation),
      onTerminal: job => files?.onTerminal(job),
    });
    const automation = commandState && createCommandAutomation({ queue, state: commandState, definition, classify, evaluators, audit: targetAudit, maxCalls: settings.jevMaxCalls, budget: automationBudget });
    commands = createCommandService({ queue, classify, executeCommand: checkedExecute, audit: targetAudit, target, readProfile, claimExecution, automation });
    files = createFileService({ store: targetStore, queue, transfers, claimImport });
    return { ...definition, queue, commands, files, transfers, store: targetStore };
  });
  const targets = createTargetRouter(runtimes, { defaultTarget: settings.targets === null ? 'default' : settings.defaultTarget, legacy: settings.targets === null, store, audit });
  const { queue, commands, files } = targets;
  for (const job of commandState?.list() ?? []) {
    const runtime = runtimes.find(runtime => runtime.id === (job.targetId ?? 'default'));
    runtime?.queue.restore(job, value => commandState.save(value));
  }
  const policyReview = commandState && createCommandPolicyReview({ state: commandState, audit, nonce: () => randomBytes(24).toString('hex'),
    evaluator: policyRiskAssessor ?? (settings.jevEnabled ? createJevAssessor({ apiKey, question: COMMAND_SET_QUESTION, inputKind: 'registration' }) : undefined),
    maxCalls: settings.jevMaxCalls, budget: automationBudget,
    validateTargets(value) {
      for (const rule of value.targets) {
        const runtime = targets.select(rule.targetId); runtime.verify();
        if (rule.targetRevision !== runtime.revision || rule.profile !== runtime.writeProfile) throw Error('Stale command policy target');
      }
    },
  });
  const commandPolicy = commandState && {
    get: () => ({ ...commandState.policy(), bindings: runtimes.map(runtime => ({ targetId: runtime.id, targetRevision: runtime.revision, profile: runtime.writeProfile, displayName: runtime.displayName })) }),
    review: policyReview.review,
    set: policyReview.set,
  };
  const requestSafety = createRequestSafety({ queue, maxCalls: settings.jevMaxCalls,
    assessor: settings.jevEnabled ? risk : undefined });
  let protocols;
  const lifecycle = createLifecycleService({ queue, store, commands, files, closeConnections: async () => { await targets.drain(); await registry.closeAll(); },
    onReap: () => protocols?.reapCapabilities() });
  const shutdown = new AbortController();
  const [webHtml, webJs] = await Promise.all([
    readFile(new URL('./web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('./web/dist/app.js', import.meta.url), 'utf8'),
  ]);
  protocols = createProtocolAdapters({ queue, commands, files, store, lifecycle, settings, signer, adminAccess, targets, requestSafety,
    authorizeAdminRequest, uiHtml, webHtml, webJs, bindFileSource, shutdownSignal: shutdown.signal, commandPolicy });
  const timer = setInterval(() => lifecycle.reap().catch(() => {}), 30_000); timer.unref();
  let closing;
  return { ...protocols, queue, store, targets, transfers: runtimes[0].transfers, enabled: settings.uiEnabled,
    close() {
      clearInterval(timer); shutdown.abort();
      return closing ??= lifecycle.close(() => Promise.all([protocols.mcpHttp, protocols.adminHttp].map(server => new Promise(resolve => server.close(resolve))))).finally(() => commandState?.close());
    },
  };
}
