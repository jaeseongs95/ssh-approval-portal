import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createOperationStore } from './src/adapters/storage/operation-store.mjs';
import { createOperationScheduler } from './src/domain/operation-scheduler.mjs';
import { createOperations } from './src/application/operations.mjs';
import { createRuntimeCapacity } from './src/application/runtime-capacity.mjs';
import { createRuntimeCapacityState } from './src/adapters/storage/runtime-capacity-state.mjs';
import { createDesktopService } from './src/application/desktop.mjs';
import { createRfbDesktopAdapter } from './src/adapters/desktop/rfb.mjs';
import { dispatchStep, dispatchRefusal, dispatchFailureDetails } from './src/domain/dispatch-failure.mjs';
import { executionFailureDetails } from './src/domain/execution-failure.mjs';
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
import {createBrowserSessionAdapter} from './src/adapters/security/admin-browser-sessions.mjs';
import { createAdminAccess } from './src/adapters/security/admin-access.mjs';
import { authorizeAdminRequest } from './src/adapters/security/admin-policy.mjs';
import { Tickets } from './src/adapters/security/tickets.mjs';
import { createProtocolAdapters } from './src/adapters/http/protocol.mjs';
import { createJevAssessor } from './src/adapters/safety/jev.mjs';
import { createRequestSafety } from './src/application/request-safety.mjs';
import { createTestServerMode } from './src/application/test-server-mode.mjs';
import { createSecretService } from './src/application/secret-service.mjs';
import { createLocalSecretStore } from './src/adapters/secrets/local-file.mjs';
import { createVaultSecretStore } from './src/adapters/secrets/vault-kv.mjs';
import { createCommandState } from './src/adapters/storage/command-state.mjs';
import { createRetainedHistory } from './src/application/history.mjs';
import { presentJob } from './src/adapters/presentation/results.mjs';
import { openDormantCommandState } from './src/adapters/storage/offline-preservation.mjs';
import { createMaintenanceState } from './src/adapters/storage/maintenance-state.mjs';
import { capturePreservationSnapshot, comparePreservationSnapshots, BASELINE_PRESERVATION_CONTRACT, baselinePreservationAccepted } from './src/adapters/storage/preservation-verification.mjs';
import { createCommandAutomation } from './src/application/command-automation.mjs';
import { AUTOMATION_QUESTION, AUTOMATION_QUESTION_VERSION, COMMAND_SET_QUESTION, deniedCommand } from './src/domain/command-policy.mjs';
import { createCommandPolicyReview } from './src/application/command-policy-review.mjs';
import { CommandOutputs } from './src/adapters/storage/command-output.mjs';
import { hash } from './src/domain/validation.mjs';
import { createModelCatalog } from './src/application/model-catalog.mjs';
import { createAutomationMetrics } from './src/application/automation-metrics.mjs';
import { createEnvironmentEditor } from './src/adapters/config/environment-editor.mjs';
import { preparePythonSource } from './src/adapters/ssh/python-source.mjs';
import {createAgentCliState} from './src/adapters/storage/agent-cli-state.mjs';
import {createAgentCliService} from './src/application/agent-cli.mjs';
import {createAgentReleaseCatalog} from './src/adapters/releases/agent-cli.mjs';
import {prepareAgentCliPlan,prepareAgentCliStatus} from './src/adapters/ssh/agent-cli.mjs';
import {agentCliProviders,AGENT_CLI_CONTRACT} from './src/domain/agent-cli.mjs';
import {platformOf, targetCapabilities, classifyForTarget, requireTargetCapability} from './src/domain/target-platform.mjs';
import {prepareWindowsCommand} from './src/adapters/ssh/windows-command.mjs';

// Preserve the original injectable createApplication callback at the composition boundary.
// Concrete runtime executors already return the neutral outcome accepted by use cases.
const commandExecutor = execute => async (profile, command, beforeDispatch, options) => {
  const value = await execute(profile, command, beforeDispatch, options);
  if (value && typeof value.failed === 'boolean' && Array.isArray(value.texts)) return value;
  return { failed: Boolean(value?.isError), texts: (value?.content ?? []).filter(x => x.type === 'text').map(x => x.text),
    ...(value?.structuredContent === undefined ? {} : { data: value.structuredContent }) };
};

/** Assemble concrete ports. Business policy belongs to application/domain modules. */
export async function createApplication({ registry, classify, executeCommand, executePythonSource, executeAgentCli, openDesktopChannel, agentReleaseCatalog, audit, transferRoot, env = process.env, uiHtml, accessKeySet, uploadSource, riskAssessor, policyRiskAssessor, secretResolver, riskEvaluators = {}, environmentTransport, requestAdmission }) {
  const settings = parseSettings(env);
  const adminAccess = createAdminAccess(env, accessKeySet);
  const browserSessions=['access','oidc'].includes(adminAccess.mode)?createBrowserSessionAdapter():undefined;
  const signer = new Tickets(env.BRIDGE_UI_TICKET_KEY);
  const definitions = resolveTargets(settings, registry);
  let outputs, commandState, dormantCommandState, cliState, maintenanceState, operationStore, scheduler, capacity, desktopService;
  const store = new Artifacts(transferRoot, { maxBytes: settings.maxBytes, budget: settings.budget, canReap: () => !maintenanceState?.occupied() });
  const submissions = new AsyncLocalStorage();
  const probeExecutors = new Map();
  try {
  // Prepare only the private directory; opening the fence must precede any TTL cleanup.
  await store.prepareRoot();
  maintenanceState = createMaintenanceState(transferRoot);
  await store.init();
  outputs = new CommandOutputs(transferRoot, {canReap: () => !maintenanceState.occupied()});
  let resolver = secretResolver;
  if (!resolver) {
    const providers = settings.secretStoreDir ? { 'local-file': createLocalSecretStore(settings.secretStoreDir) } : {};
    const local = createSecretService(providers);
    if (settings.vaultOrigin && settings.vaultTokenRef) providers.vault = createVaultSecretStore({
      origin: settings.vaultOrigin, mount: settings.vaultMount, getToken: () => local.resolve(settings.vaultTokenRef),
    });
    resolver = createSecretService(providers);
  }
  const testServerMode = createTestServerMode({ reference: settings.testServerSecretRef, resolver });
  let risk = riskAssessor, apiKey;
  if (settings.jevEnabled) {
    apiKey = env.JEV_API_KEY;
    if (!apiKey && settings.jevKeyRef) {
      try {
        apiKey = await resolver.resolve(settings.jevKeyRef);
      } catch { /* Missing keys grant no authority. */ }
    }
    risk ??= createJevAssessor({ apiKey });
  }
  commandState = settings.commandAutomation ? createCommandState(transferRoot) : undefined;
  dormantCommandState = settings.commandAutomation ? undefined : openDormantCommandState(transferRoot);
  cliState = executeAgentCli ? createAgentCliState(transferRoot) : undefined;
  const cliCatalog = cliState && (agentReleaseCatalog ?? createAgentReleaseCatalog());
  const evaluators = { ...riskEvaluators };
  const automationBudget = { used: 0 };
  const sourceBudget = { bytes: 0, count: 0 };
  if (settings.jevEnabled && !evaluators.jev) evaluators.jev = createJevAssessor({ apiKey, question: AUTOMATION_QUESTION, questionVersion: AUTOMATION_QUESTION_VERSION, inputKind: 'execution' });
  const modelCatalog = createModelCatalog({ jev: policyRiskAssessor ?? (settings.jevEnabled ? createJevAssessor({ apiKey }) : undefined), providers: evaluators, configured: Boolean(policyRiskAssessor || (settings.jevEnabled && apiKey)) });
  const source = uploadSource ?? createFileSource({ hosts: settings.uploadHosts, maxBytes: settings.maxBytes });
  const bindFileSource = url => source.bind ? source.bind(url) : {
    inspect() { const policy = source.inspect(url); return { allowed: policy.allowed, sourceHost: policy.sourceHost ?? policy.hostname }; },
    open: options => source.open(url, options),
  };
  const execute = commandExecutor(executeCommand), claimImport = createClaims(settings.maxConcurrency);
  operationStore = createOperationStore(transferRoot);
  let runtimes = [];
  scheduler = createOperationScheduler({ store: operationStore, paused: true,
    globalConcurrency: settings.maxConcurrency, queueCapacity: settings.queueCapacity,
    targetConcurrency: Object.fromEntries(definitions.map(target => [target.id,target.maxConcurrency])),
    targetQueueCapacity: Object.fromEntries(definitions.map(target => [target.id,target.queueCapacity])),
    beforeDispatch: record => { const target = runtimes.find(target => target.id === record.targetId); if (!target || target.revision !== record.targetRevision) throw Error('TARGET_REVISION_CONFLICT'); target.verify(); if (maintenanceState.occupied()) throw Error('MAINTENANCE_ACTIVE'); },
    execute: (record, options) => {
      if (record.kind === 'cli-probe') { const execute = probeExecutors.get(record.id); if (!execute) throw Error('CLI_PROBE_NOT_REPLAYABLE'); return execute(options); }
      const target = runtimes.find(target => target.id === record.targetId); return target.queue.executeScheduled(record.id, options);
    },
    onChange: record => runtimes.find(target => target.id === record.targetId)?.queue.syncOperation(record),
  });
  runtimes = definitions.map(definition => {
    const { target, readProfile, writeProfile, identity } = definition;
    const platform = platformOf(definition), targetClassify = classifyForTarget(definition, classify);
    const targetStore = identity ? scopedArtifacts(store, identity) : store;
    const checkedRegistry = { getProfile: profile => registry.getProfile(profile), getOrCreate(profile) { definition.verify(); return registry.getOrCreate(profile); } };
    const pathPolicy = async () => {
      definition.verify();
      const policy = commandState?.policy();
      const rule = policy?.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
      if (rule?.testServer !== true) return { bypassRoot: false };
      await testServerMode.require();
      definition.verify();
      if (commandState?.policy().revision !== policy.revision) dispatchRefusal('policy_changed', 'policy_guard', 'File path policy changed');
      return { bypassRoot: true };
    };
    const transfers = createTransferExecutor(checkedRegistry, targetStore, { readProfile, writeProfile, platform, pathPolicy });
    const binding = (profile, command, executionId) => ({ executionId, targetId: definition.id, targetRevision: definition.revision, profile, operationDigest: hash(command) });
    const dispatchGuard = id => {
      const before = commandState?.policy(), submitted = id ? queue.get(id) : undefined;
      const subject = submitted && queue.subject(id);
      const rule = before?.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
      const verify = () => {
        dispatchStep('target_guard', () => definition.verify(), 'target_changed');
        if (queue.maintenance) dispatchRefusal('maintenance', 'maintenance', 'Maintenance in progress');
        if (commandState?.policy().revision !== before?.revision) dispatchRefusal('policy_changed', 'policy_guard', 'Dispatch policy changed');
        if (!submitted) return; // Immediate read/probe IDs do not belong to the approval queue.
        const job = queue.get(id);
        if (!job || job.state !== 'running' || queue.subject(id) !== subject) dispatchRefusal('request_state', 'request_state', 'Dispatch request changed');
        if (queue.now() >= job.expiresAt) dispatchRefusal('plan_expired', 'request_state', 'Dispatch approval expired');
        if (!job.operation.readOnly && job.approvalMode === 'automatic' && job.decision?.policyRevision !== before?.revision) dispatchRefusal('policy_changed', 'policy_guard', 'Dispatch approval policy changed');
        if (job.operation.kind === 'command' && !job.operation.readOnly) queue.beforeCommandStart?.(job);
        // File policy hooks grant automatic authority; manual owner approval stays manual.
        else if (job.approvalMode === 'automatic' && job.operation.kind === 'upload') queue.beforeUploadStart(job);
        else if (job.approvalMode === 'automatic' && job.operation.kind === 'download') queue.beforeDownloadStart(job);
      };
      const beforeDispatch = async () => {
        verify();
        if (rule?.testServer === true || submitted?.decision?.reasonCode === 'test_server_bypass') {
          try { await testServerMode.require(); }
          catch { dispatchRefusal('authority', 'policy_guard', 'Test authority is unavailable'); }
        }
        verify();
      };
      // The adapter also calls this synchronously at getClient(), after the final await.
      beforeDispatch.verify = verify;
      // Only the transfer adapter's fixed own-stage cleanup uses this authority.
      // Revocation stops new work, while the original target identity stays mandatory.
      beforeDispatch.cleanup = () => definition.verify();
      return beforeDispatch;
    };
    const checkedExecute = async (profile, command, id = randomBytes(24).toString('hex'), beforeDispatch = dispatchGuard(id), options = {}) => {
      definition.verify();
      const dispatch = platform === 'windows' ? prepareWindowsCommand(command, { workdir: definition.workdir }) : { command };
      const reservation = outputs.reserve(binding(profile, command, id));
      const stream = outputs.beginStream(reservation);
      if (operationStore.get(id)) operationStore.update(id, { outputRef: { outputId: reservation.id, stream: true } });
      try { return outputs.finish(reservation, await execute(profile, dispatch.command, beforeDispatch, { ...options, onOutput: event => stream.append(event), ...(dispatch.stdin === undefined ? {} : { stdin: dispatch.stdin }) })); }
      catch (error) {
        const refusal = dispatchFailureDetails(error), failure = executionFailureDetails(error);
        if (refusal.dispatchFailureStage !== 'unknown' || failure.remoteOutcome === 'not_started') {
          outputs.abandon(reservation); throw error;
        }
        return outputs.finish(reservation, { failed: true, texts: [], failure,
          execution: { phase: 'settled', reason: 'transport_lost', remoteState: 'unknown', cleanupComplete: false, requiresReconciliation: true } });
      }
    };
    const targetAudit = event => audit({ ...event, ...identity });
    let commands, files, automation, cli;
    const cliProbes = new Set();
    const checkedSourceExecute = async (operation, id, beforeDispatch, options = {}) => {
      definition.verify();
      requireTargetCapability(definition, 'pythonSource');
      const plan = automation.sourcePlan(id);
      const reservation = outputs.reserve({ executionId: id, targetId: definition.id, targetRevision: definition.revision, profile: writeProfile, operationDigest: plan.planDigest });
      const stream = outputs.beginStream(reservation);
      operationStore.update(id, { outputRef: { outputId: reservation.id, stream: true } });
      try { return outputs.finish(reservation, await executePythonSource(plan, () => {
        definition.verify(); automation.sourcePlan(id); queue.beforeCommandStart(queue.get(id));
        return { targetId: definition.id, targetRevision: definition.revision, profile: writeProfile };
      }, beforeDispatch, { ...options, onOutput: event => stream.append(event) })); } catch (error) { outputs.abandon(reservation); throw error; }
    };
    const queueIdentity = identity ?? { targetId: definition.id, targetRevision: definition.revision, targetDisplayName: definition.displayName };
    const queue = new ApprovalQueue({ classify: targetClassify, target, profile: writeProfile, readProfile, requestCapacity: settings.requestCapacity, audit: targetAudit, identity: queueIdentity, scheduler, operationStore, submissionIdentity: () => submissions.getStore(),
      executeOperation: async (operation, id, options = {}) => {
        if (operation.agentCliContract) requireTargetCapability(definition, 'agentCli');
        if (operation.sourceContract && !operation.agentCliContract) requireTargetCapability(definition, 'pythonSource');
        const beforeDispatch = dispatchGuard(id);
        await beforeDispatch();
        const outcome = await (operation.agentCliContract === AGENT_CLI_CONTRACT ? cli.execute(id, beforeDispatch, options) : operation.kind === 'command' ? operation.sourceContract ? checkedSourceExecute(operation, id, beforeDispatch, options) : checkedExecute(operation.readOnly ? readProfile : writeProfile, operation.command, id, beforeDispatch, options)
          : operation.kind === 'upload' ? transfers.upload(operation, beforeDispatch) : transfers.download(operation, beforeDispatch));
        // SFTP returns only after its own verified channel/file cleanup. Uncertain transfer errors remain unknown.
        return outcome.execution ? outcome : { ...outcome, execution: { phase: 'settled', reason: 'exit', remoteState: 'exited', cleanupComplete: true, requiresReconciliation: false, exitCode: outcome.failed ? 1 : 0 } };
      },
      onTerminal: job => { try { cli?.onTerminal(job); automation?.onTerminal(job); } finally { files?.onTerminal(job); } },
    });
    automation = commandState && createCommandAutomation({ queue, state: commandState, definition, classify: targetClassify, evaluators, audit: targetAudit,
      ...(executePythonSource ? { prepareSource: preparePythonSource } : {}), sourceBudget, maxCalls: settings.jevMaxCalls, budget: automationBudget });
    const cliBinding = () => ({targetId:definition.id,targetRevision:definition.revision,profile:writeProfile,...(platform === 'windows' ? {platform} : {})});
    const checkCliPolicy = plan => {
      dispatchStep('target_guard', () => definition.verify(), 'target_changed');
      requireTargetCapability(definition, 'agentCli');
      const rule = commandState?.policy().targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
      if (!rule?.testServer && deniedCommand(plan.command+'\n'+plan.stdin+'\n'+plan.manifest.argvJson,rule)) dispatchRefusal('policy_denied', 'policy_guard', 'CLI operation denied by current policy');
    };
    const checkedCliProbe = async plan => {
      definition.verify();checkCliPolicy(plan);
      if(queue.maintenance)throw Error('CLI maintenance in progress');
      const beforeDispatch=dispatchGuard();
      const id=randomBytes(24).toString('hex');
      operationStore.accept({ id, requestKey: id, owner: 'cli-probe', targetId: definition.id, targetRevision: definition.revision, kind: 'cli-probe', input: { action: plan.action ?? 'probe', planDigest: hash(JSON.stringify(plan)) } });
      targetAudit({action:'cli-probe-started',id,profile:writeProfile,targetId:definition.id});
      probeExecutors.set(id, async options => {
        await beforeDispatch();
        return executeAgentCli(plan,()=>{definition.verify();checkCliPolicy(plan);if(queue.maintenance)throw Error('CLI maintenance in progress');return cliBinding();}, beforeDispatch, options);
      });
      const task=(async()=>{
        scheduler.enqueue(id);
        let record=operationStore.get(id);
        while(!['completed','failed','cancelled','expired','denied','unknown'].includes(record.state)) record=await scheduler.observe(id,{timeoutMs:60000});
        if(!record.result)throw Error('CLI_PROBE_OUTCOME_UNAVAILABLE');
        return record.result;
      })().finally(()=>{cliProbes.delete(task);probeExecutors.delete(id);targetAudit({action:'cli-probe-finished',id,profile:writeProfile,targetId:definition.id});});
      cliProbes.add(task);return task;
    };
    if(cliState){
      cli=createAgentCliService({queue,journal:cliState,resolveTarget:id=>id===definition.id?definition:null,
        readLoginState:async(provider,binding)=>(await checkedCliProbe(prepareAgentCliPlan({action:'login-status',provider,binding}))).data?.agentCli,
        readInstallation:async(provider,binding)=>(await checkedCliProbe(prepareAgentCliPlan({action:'inspect',provider,binding}))).data?.agentCli,
        automaticDecision:()=>{
          const policy=commandState?.policy(),rule=policy?.targets.find(rule=>rule.targetId===definition.id&&rule.targetRevision===definition.revision&&rule.profile===writeProfile);
          return rule?.testServer===true?{decision:'execute',reasonCode:'test_server_bypass',policyRevision:policy.revision,targetRevision:definition.revision}:undefined;
        },
        catalog:cliCatalog,preparePlan:prepareAgentCliPlan,executePlan:executeAgentCli,outputs,checkPolicy:checkCliPolicy,nonce:()=>randomBytes(24).toString('hex')});
      const originalGuard=queue.beforeCommandStart;
      queue.beforeCommandStart=job=>cli.isJob(job)?cli.beforeStart(job):originalGuard?.(job);
    }
    queue.beforeUploadStart = job => {
      dispatchStep('target_guard', () => definition.verify(), 'target_changed');
      const policy = commandState?.policy(), rule = policy?.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
      if (rule?.testServer !== true && (rule?.automaticUploads !== true || job.operation.elevate || job.operation.overwrite)) dispatchRefusal('policy_denied', 'policy_guard', 'Automatic uploads not enabled by the user');
      return { decision: 'execute', reasonCode: rule?.testServer === true ? 'test_server_bypass' : 'upload_policy', policyRevision: policy.revision, targetRevision: definition.revision };
    };
    queue.beforeDownloadStart = job => {
      dispatchStep('target_guard', () => definition.verify(), 'target_changed');
      const policy = commandState?.policy(), rule = policy?.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
      if (rule?.testServer !== true && (rule?.automaticDownloads !== true || (job.operation.elevate && rule.automaticSudo !== true))) dispatchRefusal('policy_denied', 'policy_guard', 'Automatic download not enabled by the user');
      return { decision: 'execute', reasonCode: rule?.testServer === true ? 'test_server_bypass' : 'download_policy', policyRevision: policy.revision, targetRevision: definition.revision };
    };
    commands = createCommandService({ queue, classify: targetClassify, executeCommand: checkedExecute, audit: targetAudit, target, readProfile, automation });
    files = createFileService({ store: targetStore, queue, transfers, claimImport, platform });
    return { ...definition, queue, commands, files, transfers, store: targetStore,cli,
      async filePolicy() {
        const policy = commandState?.policy();
        const rule = policy?.targets.find(rule => rule.targetId === definition.id && rule.targetRevision === definition.revision && rule.profile === writeProfile);
        const active = rule?.testServer === true && await testServerMode.available();
        definition.verify();
        if (commandState?.policy().revision !== policy?.revision) throw Error('File policy changed during discovery');
        return { testServerConfigured: rule?.testServer === true, testServerActive: active,
          mode: platform === 'windows' ? active ? 'test-server-bypass' : 'configured-root' : 'ssh-account-permissions',
          allowedRoot: platform === 'windows' ? transfers.rootObservation?.allowedRoot ?? null : null,
          allowedRootObservedAt: platform === 'windows' ? transfers.rootObservation?.observedAt ?? null : null,
          osPermissionsEnforced: true, pathSafetyEnforced: true, elevationRequiresExplicitRequest: true };
      },
      cliProbe:checkedCliProbe,cliDrain:()=>Promise.allSettled([...cliProbes]) };
  });
  const targets = createTargetRouter(runtimes, { defaultTarget: settings.targets === null ? 'default' : settings.defaultTarget, legacy: settings.targets === null, store, audit,
    executionBusy: () => { const state = scheduler.snapshot(); return state.active > 0 || state.queued > 0; } });
  const { queue, commands, files } = targets;
  const maintenanceProperty = Object.getOwnPropertyDescriptor(queue, 'maintenance');
  Object.defineProperty(queue, 'maintenance', { enumerable: true, configurable: true,
    get: () => maintenanceProperty.get.call(queue),
    set: value => { maintenanceProperty.set.call(queue, value); scheduler.configure({ paused: Boolean(value) }); },
  });
  for (const job of commandState?.list() ?? []) {
    const runtime = runtimes.find(runtime => runtime.id === (job.targetId ?? 'default'));
    if (runtime && job.kind === 'command' && job.result && !job.result.output) {
      // Publish before replacing the legacy body. On failure the original DB body survives;
      // presenters still refuse to expose it. Execution/replay identity is never changed.
      let migrated = { failed: job.result.failed, texts: [], output: { state: 'unavailable', captureSource: 'redacted-adapter-outcome', sshCompleteness: 'unknown', version: 1 } };
      // A reserved restart must retain the baseline row; only sanitize the in-memory view.
      if (!maintenanceState.occupied()) {
        try {
          migrated = outputs.finish(outputs.reserve({ executionId: job.id, targetId: runtime.id, targetRevision: job.targetRevision ?? runtime.revision, profile: job.profile, operationDigest: hash(job.command) }), job.result);
          if (migrated.output.state === 'ready') commandState.save({ ...job, result: migrated });
        } catch { /* Preserve the legacy journal; no raw fallback or SSH replay. */ }
      }
      job.result = migrated;
    }
    runtime?.queue.restore(job, value => commandState.save(value));
  }
  for(const job of cliState?.list() ?? []){
    const runtime=runtimes.find(runtime=>runtime.id===job.operation.agentCliTargetId);
    if(runtime){if(runtime.queue.jobs.has(job.id))throw Error('Duplicate persisted CLI request ID');runtime.queue.restore(job,value=>cliState.save(value));}
  }
  // Reconstruct approved views from immutable operation intents. Never reconstruct private source closures.
  for (const record of operationStore.list()) {
    const runtime = runtimes.find(target => target.id === record.targetId && target.revision === record.targetRevision);
    if (runtime && !runtime.queue.get(record.id) && record.metadata?.approval) runtime.queue.restore(record.metadata.approval);
    if (runtime) runtime.queue.syncOperation(record, { restoring: true });
  }
  capacity = createRuntimeCapacity({ state: createRuntimeCapacityState(transferRoot), settings, targets: definitions,
    newRevision: () => randomBytes(16).toString('hex'),
    scheduler: { ...scheduler, list: () => operationStore.list() }, audit, maintenance: () => targets.queue.maintenance });
  const operations = createOperations({ targets, queue, commands, files, journal: operationStore, scheduler, submissions, outputs });
  files.readDownload = args => {
    const record = operationStore.get(args.id); if (!record) throw Object.assign(Error('OPERATION_NOT_FOUND'),{code:'OPERATION_NOT_FOUND'});
    const runtime = targets.select(record.targetId); runtime.verify();
    if (runtime.revision !== record.targetRevision) throw Object.assign(Error('TARGET_REVISION_CONFLICT'),{code:'TARGET_REVISION_CONFLICT'});
    return runtime.files.readAgentDownload(args, runtime.verify);
  };
  let desktop;
  if (openDesktopChannel) {
    const adapter = createRfbDesktopAdapter({ allowNoneSecurity: true,
      openChannel: ({ binding, host, port, signal }) => { const runtime = targets.select(binding.targetId); runtime.verify();
        if (runtime.revision !== binding.targetRevision) throw Object.assign(Error('DESKTOP_STALE_TARGET'),{code:'DESKTOP_STALE_TARGET'});
        if (runtime.desktop?.enabled !== true) throw Object.assign(Error('DESKTOP_UNAVAILABLE'),{code:'DESKTOP_UNAVAILABLE'});
        return openDesktopChannel(runtime.writeProfile, { host, port: runtime.desktop.port, signal, beforeDispatch: async () => { runtime.verify(); if (queue.maintenance) throw Error('MAINTENANCE_ACTIVE'); } });
      } });
    const permittedDesktop = new Map(), desktopBindings = new Map();
    const authorizeDesktop = async binding => {
      const permission = permittedDesktop.get(JSON.stringify(binding));
      if (!permission) return false;
      if (binding.ownerId !== 'mcp-shared-principal') return true;
      const runtime = targets.select(binding.targetId);
      const validPolicy = () => {
        const current = commandState?.policy();
        return current?.revision === permission.policyRevision && current.targets.some(rule =>
          rule.targetId === runtime.id && rule.targetRevision === runtime.revision && rule.profile === runtime.writeProfile && rule.testServer === true);
      };
      if (!validPolicy()) return false;
      try { await testServerMode.require(); runtime.verify(); return validPolicy(); } catch { return false; }
    };
    desktopService = createDesktopService({ adapter,
      maxSessions: settings.maxConcurrency, maxPerOwner: settings.maxConcurrency,
      authorize: authorizeDesktop,
      leaseKey: binding => {
        const runtime = targets.select(binding.targetId), profile = registry.getProfile(runtime.writeProfile);
        return hash(JSON.stringify([profile.trustedHostKey, runtime.desktop.port]));
      },
      verifyTarget: binding => { try { const runtime = targets.select(binding.targetId); runtime.verify(); return runtime.revision === binding.targetRevision && !queue.maintenance; } catch { return false; } },
      onClose: receipt => {
        const binding = desktopBindings.get(receipt.sessionId);
        if (binding) permittedDesktop.delete(JSON.stringify(binding));
        desktopBindings.delete(receipt.sessionId);
      },
    });
    let epoch = 0;
    desktop = {
      async open({ target, expectedTargetRevision }, ownerId = 'mcp-shared-principal') {
        const runtime = targets.select(target); runtime.verify();
        if (expectedTargetRevision !== runtime.revision || queue.maintenance) throw Object.assign(Error('DESKTOP_STALE_TARGET'),{code:'DESKTOP_STALE_TARGET'});
        if (runtime.desktop?.enabled !== true) throw Object.assign(Error('DESKTOP_UNAVAILABLE'),{code:'DESKTOP_UNAVAILABLE'});
        // Administrative desktop access is explicit. Agent access follows this target's TEST bypass authority.
        if (ownerId === 'mcp-shared-principal' && !(await runtime.filePolicy()).testServerActive) throw Object.assign(Error('DESKTOP_OWNER_APPROVAL_REQUIRED'), { code: 'DESKTOP_OWNER_APPROVAL_REQUIRED' });
        const binding = { ownerId, targetId: runtime.id, targetRevision: runtime.revision, epoch: ++epoch };
        const key = JSON.stringify(binding);
        permittedDesktop.set(key, { policyRevision: commandState?.policy().revision });
        try {
          const session = await desktopService.open(binding); desktopBindings.set(session.sessionId, binding); return session;
        } catch (error) { permittedDesktop.delete(key); throw error; }
      },
      observe: (args, ownerId = 'mcp-shared-principal') => desktopService.observe({ ...args, ownerId }),
      input: (args, ownerId = 'mcp-shared-principal') => desktopService.input({ ...args, ownerId }),
      close: (args, ownerId = 'mcp-shared-principal') => desktopService.close({ ...args, ownerId }),
      closeOwner: ownerId => desktopService.closeOwner(ownerId),
    };
  }
  const cliRequest=id=>{
    const saved=cliState?.get(id);if(!saved)throw Error('Unknown CLI request');
    const runtime=targets.select(saved.job.operation.agentCliTargetId);runtime.verify();
    if(saved.job.operation.agentCliTargetRevision!==runtime.revision||saved.job.operation.agentCliProfile!==runtime.writeProfile)throw Error('CLI target changed');
    return {runtime,job:runtime.queue.get(id)??saved.job,remoteStatus:saved.remoteStatus};
  };
  const oneId=body=>{if(!body||Object.keys(body).length!==1||typeof body.requestId!=='string'||!/^[a-f0-9]{48}$/.test(body.requestId))throw Error('Invalid CLI request fields');return body.requestId;};
  const agentCli={
    get:()=>({available:Boolean(cliState),providers:agentCliProviders(),bindings:runtimes.map(runtime=>({targetId:runtime.id,targetRevision:runtime.revision,profile:runtime.writeProfile,displayName:runtime.displayName,sshTarget:runtime.target,enabled:runtime.enabled,platform:platformOf(runtime),supported:targetCapabilities(runtime).agentCli}))}),
    history:({targetId,provider,before,beforeId})=>{
      if(typeof targetId!=='string'||!['codex','claude'].includes(provider)||!cliState)throw Error('Invalid CLI history');
      const runtime=targets.select(targetId);runtime.verify();
      const binding={targetId:runtime.id,targetRevision:runtime.revision,profile:runtime.writeProfile};
      return {binding,provider,...cliState.history({...binding,provider},before===undefined?null:{before,beforeId})};
    },
    lookup:({key,targetId,provider})=>{
      if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{16,128}$/.test(key)||!['codex','claude'].includes(provider)||typeof targetId!=='string')throw Error('Invalid CLI lookup');
      const runtime=targets.select(targetId);runtime.verify();
      const saved=cliState?.find('agent-cli:'+key);if(!saved)return {found:false};
      if(saved.job.operation.agentCliTargetId!==targetId||saved.job.operation.agentCliProvider!==provider)throw Error('CLI lookup binding mismatch');
      return {found:true,...agentCli.request(saved.job.id)};
    },
    'login-status':body=>{const runtime=targets.select(body?.targetId);requireTargetCapability(runtime,'agentCli');if(!runtime.cli)throw Error('CLI unavailable');return runtime.cli.loginStatus(body);},
    preview:body=>{const runtime=targets.select(body?.targetId);requireTargetCapability(runtime,'agentCli');if(!runtime.cli)throw Error('CLI unavailable');return runtime.cli.preview(body);},
    submit:body=>{const runtime=targets.select(body?.request?.targetId);requireTargetCapability(runtime,'agentCli');if(!runtime.cli)throw Error('CLI unavailable');return runtime.cli.submit(body);},
    request:id=>{const {job,remoteStatus}=cliRequest(id);return {job,remoteStatus};},
    start:body=>{const {runtime,job}=cliRequest(oneId(body));return job.state==='pending'?runtime.queue.start(job.id):job;},
    reconcile:async body=>{const {runtime,job}=cliRequest(oneId(body));const binding={targetId:runtime.id,targetRevision:runtime.revision,profile:runtime.writeProfile,...(platformOf(runtime)==='windows'?{platform:'windows'}:{})};
      const result=await runtime.cliProbe(prepareAgentCliStatus(job.operation,binding));return {requestId:job.id,remoteStatus:cliState.recordRemote(job.id,result.data?.agentCli)};},
  };
  const ordinarySource=commands.source;
  commands.source=id=>{const job=queue.get(id);return job?.operation?.agentCliContract===AGENT_CLI_CONTRACT?targets.select(job.operation.agentCliTargetId).cli.source(id):ordinarySource(id);};
  const commandOutputs = {
    read(args) { return outputs.read(args, binding => {
      const runtime = targets.select(args.target ?? binding.targetId); runtime.verify();
      if (runtime.id !== binding.targetId || runtime.revision !== binding.targetRevision || ![runtime.readProfile, runtime.writeProfile].includes(binding.profile)) throw Error('Stale output target binding');
    }); },
  };
  const policyReview = commandState && createCommandPolicyReview({ state: commandState, audit, nonce: () => randomBytes(24).toString('hex'),
    evaluator: policyRiskAssessor ?? (settings.jevEnabled ? createJevAssessor({ apiKey, question: COMMAND_SET_QUESTION, inputKind: 'registration' }) : undefined),
    maxCalls: settings.jevMaxCalls, budget: automationBudget,
    targetPlatform(rule) {
      const runtime = targets.select(rule.targetId); runtime.verify();
      return platformOf(runtime);
    },
    validateTargets(value) {
      for (const rule of value.targets) {
        const runtime = targets.select(rule.targetId); runtime.verify();
        if (rule.targetRevision !== runtime.revision || rule.profile !== runtime.writeProfile || (rule.platform ?? 'linux') !== platformOf(runtime)) throw Error('Stale command policy target');
      }
    },
  });
  const commandPolicy = commandState && {
    get: async () => ({ ...commandState.policy(), testServerAvailable: await testServerMode.available(), evaluators: await modelCatalog.get(), bindings: runtimes.map(runtime => ({ targetId: runtime.id, targetRevision: runtime.revision, profile: runtime.writeProfile, displayName: runtime.displayName, enabled: runtime.enabled, platform: platformOf(runtime), capabilities: targetCapabilities(runtime) })) }),
    async review(policy, revision) {
      if (policy?.targets?.some(rule => rule.testServer === true)) await testServerMode.require();
      return policyReview.review(policy, revision);
    },
    async set(policy, revision, token, acknowledged) {
      if (policy?.targets?.some(rule => rule.testServer === true)) await testServerMode.require();
      return policyReview.set(policy, revision, token, acknowledged);
    },
  };
  const requestSafety = createRequestSafety({ queue, maxCalls: settings.jevMaxCalls,
    targetPlatform(job) {
      const runtime = targets.select(job.targetId); runtime.verify();
      if (job.targetRevision && job.targetRevision !== runtime.revision) throw Error('Stale command target');
      return platformOf(runtime);
    },
    assessor: settings.jevEnabled ? risk : undefined });
  let protocols;
  const lifecycle = createLifecycleService({ queue, store, commands, files, maintenanceState, closeConnections: async () => { await desktopService?.closeAll(); await targets.drain(); await registry.closeAll(); },
    onReap: () => { protocols?.reapCapabilities(); void modelCatalog.refreshDue(); } });
  const preservationInstance = randomBytes(32).toString('hex');
  const preservation = {
    capture(owner) {
      if (!maintenanceState.owns(owner) || !queue.maintenance || queue.busy() || queue.listAll().some(job => ['pending', 'evaluating', 'running'].includes(job.state)) || commands.busy() || files.busy() || store.hasActiveWork()) throw Error('Preservation boundary unavailable');
      const prior = maintenanceState.baseline(owner);
      if (prior) { if (prior.instance !== preservationInstance) throw Error('Preservation baseline already belongs to an earlier instance'); return; }
      maintenanceState.saveBaseline(owner, { instance: preservationInstance, snapshot: capturePreservationSnapshot({ commandState: commandState ?? dormantCommandState, cliState, outputs }) });
    },
    compare(owner, contract) {
      // A failed new comparison must never leave an earlier release authorization alive.
      lifecycle.invalidateComparison(owner);
      if (contract !== undefined && contract !== BASELINE_PRESERVATION_CONTRACT) throw Error('Unsupported preservation contract');
      if (!maintenanceState.owns(owner) || !queue.maintenance || queue.busy() || queue.listAll().some(job => ['pending', 'evaluating', 'running'].includes(job.state)) || commands.busy() || files.busy() || store.hasActiveWork()) throw Error('Preservation boundary unavailable');
      const baseline = maintenanceState.baseline(owner);
      if (!baseline || baseline.instance === preservationInstance) throw Error('A new service instance is required');
      const result = comparePreservationSnapshots(baseline.snapshot, capturePreservationSnapshot({ commandState: commandState ?? dormantCommandState, cliState, outputs }));
      if (contract === BASELINE_PRESERVATION_CONTRACT ? baselinePreservationAccepted(result) : result.status === 'PASS') lifecycle.markCompared(owner, contract ? 'baseline' : 'strict');
      return result;
    },
    releaseVerified(owner, contract) {
      if (contract !== undefined && contract !== BASELINE_PRESERVATION_CONTRACT) { lifecycle.invalidateComparison(owner); throw Error('Unsupported preservation contract'); }
      const mode = contract ? 'baseline' : 'strict';
      // Reconcile a lost release reply only within the same instance and verification mode.
      if (lifecycle.requireCompared(owner, mode) === 'released') return;
      preservation.compare(owner, contract);
      lifecycle.release(owner, true, mode);
    },
  };
  const environmentEditor = createEnvironmentEditor({ lifecycle, audit, ...(environmentTransport ? { transport: environmentTransport } : {}) });
  const shutdown = new AbortController();
  const [webHtml, webJs] = await Promise.all([
    readFile(new URL('./web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('./web/dist/app.js', import.meta.url), 'utf8'),
  ]);
  const retainedHistory = createRetainedHistory({ commandJournal: commandState ?? dormantCommandState, cliJournal: cliState,
    readQueue: () => runtimes.flatMap(runtime => [...runtime.queue.jobs.values()]),
    readTargets: () => runtimes.map(runtime => ({ id: runtime.id, revision: runtime.revision, enabled: runtime.enabled, writeProfile: runtime.writeProfile })),
    verifyCliTarget: id => { targets.select(id).verify(); }, present: presentJob });
  let deploymentGeneration = null;
  try { deploymentGeneration = createHash('sha256').update(await readFile(new URL('./release-manifest.json', import.meta.url))).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  protocols = createProtocolAdapters({ queue, commands, files, store, lifecycle, settings, signer, adminAccess, browserSessions, targets, requestSafety, retainedHistory, operations, capacity, desktop, deploymentGeneration,
    authorizeAdminRequest, uiHtml, webHtml, webJs, bindFileSource, shutdownSignal: shutdown.signal, commandPolicy, commandOutputs, environmentEditor,agentCli, preservation, requestAdmission, automationMetrics: createAutomationMetrics({state:commandState}) });
  const timer = setInterval(() => { lifecycle.reap().catch(() => {}); try { outputs.reap(); } catch { /* Failed deletions stay charged. */ } }, 30_000); timer.unref();
  let closing;
  scheduler.configure({ paused: queue.maintenance });
  return { ...protocols, queue, store, targets, transfers: runtimes[0].transfers, enabled: settings.uiEnabled,
    close() {
      clearInterval(timer); shutdown.abort(); scheduler.configure({ paused: true });
      return closing ??= lifecycle.close(() => Promise.all([protocols.mcpHttp, protocols.adminHttp].map(server => new Promise(resolve => {
        // Drain normal responses, then close unfinished HTTP bodies before systemd times out.
        const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
        server.close(() => { clearTimeout(deadline); resolve(); });
      })))).finally(() => { scheduler.close(); capacity?.close(); operationStore.close(); browserSessions?.close(); for (const runtime of runtimes) {runtime.commands.close();runtime.cli?.close();} commandState?.close();dormantCommandState?.close();cliState?.close(); maintenanceState?.close(); outputs.close(); });
    },
  };
  } catch (error) { scheduler?.close(); capacity?.close(); operationStore?.close(); browserSessions?.close(); commandState?.close();dormantCommandState?.close();cliState?.close(); maintenanceState?.close(); outputs?.close(); throw error; }
}
