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
import { CommandOutputs } from './src/adapters/storage/command-output.mjs';
import { hash } from './src/domain/validation.mjs';
import { createModelCatalog } from './src/application/model-catalog.mjs';
import { createAutomationMetrics } from './src/application/automation-metrics.mjs';
import { createEnvironmentEditor } from './src/adapters/config/environment-editor.mjs';

// Preserve the original injectable createApplication callback at the composition boundary.
// Concrete runtime executors already return the neutral outcome accepted by use cases.
const commandExecutor = execute => async (profile, command) => {
  const value = await execute(profile, command);
  if (value && typeof value.failed === 'boolean' && Array.isArray(value.texts)) return value;
  return { failed: Boolean(value?.isError), texts: (value?.content ?? []).filter(x => x.type === 'text').map(x => x.text),
    ...(value?.structuredContent === undefined ? {} : { data: value.structuredContent }) };
};

/** Assemble concrete ports. Business policy belongs to application/domain modules. */
export async function createApplication({ registry, classify, executeCommand, audit, transferRoot, env = process.env, uiHtml, accessKeySet, uploadSource, riskAssessor, policyRiskAssessor, secretResolver, riskEvaluators = {}, environmentTransport }) {
  const settings = parseSettings(env);
  const adminAccess = createAdminAccess(env, accessKeySet);
  const signer = new Tickets(env.BRIDGE_UI_TICKET_KEY);
  const definitions = resolveTargets(settings, registry);
  const store = new Artifacts(transferRoot, { maxBytes: settings.maxBytes, budget: settings.budget });
  await store.init();
  const outputs = new CommandOutputs(transferRoot);
  let commandState;
  try {
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
  commandState = settings.commandAutomation ? createCommandState(transferRoot) : undefined;
  const evaluators = { ...riskEvaluators };
  const automationBudget = { used: 0 };
  if (settings.jevEnabled && !evaluators.jev) evaluators.jev = createJevAssessor({ apiKey, question: AUTOMATION_QUESTION, questionVersion: AUTOMATION_QUESTION_VERSION, inputKind: 'execution' });
  const modelCatalog = createModelCatalog({ jev: policyRiskAssessor ?? (settings.jevEnabled ? createJevAssessor({ apiKey }) : undefined), providers: evaluators, configured: Boolean(policyRiskAssessor || (settings.jevEnabled && apiKey)) });
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
    const binding = (profile, command, executionId) => ({ executionId, targetId: definition.id, targetRevision: definition.revision, profile, operationDigest: hash(command) });
    const checkedExecute = async (profile, command, id = randomBytes(24).toString('hex')) => {
      definition.verify();
      const reservation = outputs.reserve(binding(profile, command, id));
      try { return outputs.finish(reservation, await execute(profile, command)); }
      catch (error) { outputs.abandon(reservation); throw error; }
    };
    const targetAudit = event => audit({ ...event, ...identity });
    let commands, files;
    const queue = new ApprovalQueue({ classify, target, profile: writeProfile, audit: targetAudit, identity, claimExecution,
      externalBusy: () => (commands?.reading() ?? false) || claimExecution.busy(),
      executeOperation: (operation, id) => operation.kind === 'command' ? checkedExecute(writeProfile, operation.command, id)
        : operation.kind === 'upload' ? transfers.upload(operation) : transfers.download(operation),
      onTerminal: job => files?.onTerminal(job),
    });
    const automation = commandState && createCommandAutomation({ queue, state: commandState, definition, classify, evaluators, audit: targetAudit, maxCalls: settings.jevMaxCalls, budget: automationBudget });
    queue.beforeUploadStart = () => {
      definition.verify();
      const policy = commandState?.policy(), rule = policy?.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
      if (rule?.automaticUploads !== true) throw Error('Automatic uploads not enabled by the user');
      return { decision: 'execute', reasonCode: 'upload_policy', policyRevision: policy.revision, targetRevision: definition.revision };
    };
    queue.beforeDownloadStart = job => {
      definition.verify();
      const policy = commandState?.policy(), rule = policy?.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
      if (rule?.automaticDownloads !== true || (job.operation.elevate && rule.automaticSudo !== true)) throw Error('Automatic download not enabled by the user');
      return { decision: 'execute', reasonCode: 'download_policy', policyRevision: policy.revision, targetRevision: definition.revision };
    };
    commands = createCommandService({ queue, classify, executeCommand: checkedExecute, audit: targetAudit, target, readProfile, claimExecution, automation });
    files = createFileService({ store: targetStore, queue, transfers, claimImport });
    return { ...definition, queue, commands, files, transfers, store: targetStore };
  });
  const targets = createTargetRouter(runtimes, { defaultTarget: settings.targets === null ? 'default' : settings.defaultTarget, legacy: settings.targets === null, store, audit });
  const { queue, commands, files } = targets;
  for (const job of commandState?.list() ?? []) {
    const runtime = runtimes.find(runtime => runtime.id === (job.targetId ?? 'default'));
    if (runtime && job.kind === 'command' && job.result && !job.result.output) {
      // Publish before replacing the legacy body. On failure the original DB body survives;
      // presenters still refuse to expose it. Execution/replay identity is never changed.
      let migrated = { failed: job.result.failed, texts: [], output: { state: 'unavailable', captureSource: 'redacted-adapter-outcome', sshCompleteness: 'unknown', version: 1 } };
      try {
        migrated = outputs.finish(outputs.reserve({ executionId: job.id, targetId: runtime.id, targetRevision: job.targetRevision ?? runtime.revision, profile: job.profile, operationDigest: hash(job.command) }), job.result);
        if (migrated.output.state === 'ready') commandState.save({ ...job, result: migrated });
      } catch { /* Preserve the legacy journal; no raw fallback or SSH replay. */ }
      job.result = migrated;
    }
    runtime?.queue.restore(job, value => commandState.save(value));
  }
  const commandOutputs = {
    read(args) { return outputs.read(args, binding => {
      const runtime = targets.select(args.target ?? binding.targetId); runtime.verify();
      if (runtime.id !== binding.targetId || runtime.revision !== binding.targetRevision || ![runtime.readProfile, runtime.writeProfile].includes(binding.profile)) throw Error('Stale output target binding');
    }); },
  };
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
    get: async () => ({ ...commandState.policy(), evaluators: await modelCatalog.get(), bindings: runtimes.map(runtime => ({ targetId: runtime.id, targetRevision: runtime.revision, profile: runtime.writeProfile, displayName: runtime.displayName })) }),
    review: policyReview.review,
    set: policyReview.set,
  };
  const requestSafety = createRequestSafety({ queue, maxCalls: settings.jevMaxCalls,
    assessor: settings.jevEnabled ? risk : undefined });
  let protocols;
  const lifecycle = createLifecycleService({ queue, store, commands, files, closeConnections: async () => { await targets.drain(); await registry.closeAll(); },
    onReap: () => { protocols?.reapCapabilities(); void modelCatalog.refreshDue(); } });
  const environmentEditor = createEnvironmentEditor({ lifecycle, audit, ...(environmentTransport ? { transport: environmentTransport } : {}) });
  const shutdown = new AbortController();
  const [webHtml, webJs] = await Promise.all([
    readFile(new URL('./web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('./web/dist/app.js', import.meta.url), 'utf8'),
  ]);
  protocols = createProtocolAdapters({ queue, commands, files, store, lifecycle, settings, signer, adminAccess, targets, requestSafety,
    authorizeAdminRequest, uiHtml, webHtml, webJs, bindFileSource, shutdownSignal: shutdown.signal, commandPolicy, commandOutputs, environmentEditor, automationMetrics: createAutomationMetrics({state:commandState}) });
  const timer = setInterval(() => { lifecycle.reap().catch(() => {}); try { outputs.reap(); } catch { /* Failed deletions stay charged. */ } }, 30_000); timer.unref();
  let closing;
  return { ...protocols, queue, store, targets, transfers: runtimes[0].transfers, enabled: settings.uiEnabled,
    close() {
      clearInterval(timer); shutdown.abort();
      return closing ??= lifecycle.close(() => Promise.all([protocols.mcpHttp, protocols.adminHttp].map(server => new Promise(resolve => {
        // Drain normal responses, then close unfinished HTTP bodies before systemd times out.
        const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
        server.close(() => { clearTimeout(deadline); resolve(); });
      })))).finally(() => { commandState?.close(); outputs.close(); });
    },
  };
  } catch (error) { commandState?.close(); outputs.close(); throw error; }
}
