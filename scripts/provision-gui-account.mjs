#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createLocalSecretStore } from '../src/adapters/secrets/local-file.mjs';
import { createSecretService, parseSecretReference } from '../src/application/secret-service.mjs';

const fail = code => { const error = new Error('GUI account provisioning stopped'); error.code = code; throw error; };
const hash = value => createHash('sha256').update(value).digest('hex');
const sidPattern = /^S-1-5-21-(?:\d+-){3}\d+$/;
const phases = new Set(['probe', 'creating', 'created', 'group_added', 'complete', 'failed']);
const safeCodes = new Set(['INVALID_ARGUMENTS', 'SECRET_STORE_UNCONFIGURED', 'SECRET_STORE_MISMATCH', 'INVALID_TARGET', 'TARGET_CHANGED', 'ACCOUNT_EXISTS', 'SECRET_EXISTS', 'PROVISION_RECOVERY_REQUIRED', 'WINDOWS_UNAVAILABLE', 'WINDOWS_NOT_ADMIN', 'WINDOWS_FAILED', 'REMOTE_OUTCOME_UNKNOWN', 'LOCAL_STATE_FAILED', 'PUBLISH_FAILED', 'UNSAFE_STORE']);
const safeError = error => safeCodes.has(error?.code) ? error.code : 'LOCAL_STATE_FAILED';

export function parseProvisionArgs(args) {
  const result = { target: 'windows', username: 'ssh-gui-agent', apply: false };
  const names = new Map([['--target', 'target'], ['--expected-revision', 'revision'], ['--store', 'store'], ['--secret-ref', 'reference'], ['--username', 'username'], ['--status', 'status']]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (seen.has(option)) fail('INVALID_ARGUMENTS');
    seen.add(option);
    if (option === '--apply') result.apply = true;
    else if (names.has(option) && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) result[names.get(option)] = args[++i];
    else fail('INVALID_ARGUMENTS');
  }
  if (result.target !== 'windows' || !/^[a-f0-9]{64}$/.test(result.revision ?? '')
      || !/^[a-z][a-z0-9-]{2,19}$/.test(result.username) || ['administrator', 'guest', 'defaultaccount'].includes(result.username)
      || result.status && (!/^[a-f0-9-]{36}$/.test(result.status) || result.apply)) fail('INVALID_ARGUMENTS');
  try { if (parseSecretReference(result.reference).provider !== 'local-file') fail('INVALID_ARGUMENTS'); }
  catch { fail('INVALID_ARGUMENTS'); }
  return result;
}

export function generateGuiPassword() { return 'Aa9!' + randomBytes(36).toString('base64url'); }

// This fixed program accepts data only through the private non-PTY stdin pipe.
// Do not add policy changes, logoff, account replacement or password reset here.
export const WINDOWS_PROVISION_SOURCE = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$InformationPreference='SilentlyContinue'
$sid=$null
$phase='probe'
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  $line=[Console]::In.ReadLine()
  if ($null -eq $line -or $line.Length -gt 4096) { throw 'input' }
  $request=$line | ConvertFrom-Json
  $line=$null
  if ($request.mode -notin @('probe','apply') -or $request.username -cnotmatch '^[a-z][a-z0-9-]{2,19}$') { throw 'input' }
  if (-not [Environment]::Is64BitProcess -or -not (Get-Command New-LocalUser -ErrorAction SilentlyContinue) -or -not (Get-Command Add-LocalGroupMember -ErrorAction SilentlyContinue)) {
    Emit @{phase='failed';code='WINDOWS_UNAVAILABLE'}; exit 1
  }
  $principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $exists=@(Get-LocalUser | Where-Object {$_.Name -ieq $request.username}).Count -gt 0
  $group=Get-LocalGroup -SID 'S-1-5-32-555'
  if ($request.mode -eq 'probe') {
    Emit @{phase='probe';accountExists=$exists;ready=($admin -and -not $exists -and [bool]$group);domain=$env:COMPUTERNAME;code=$(if($exists){'ACCOUNT_EXISTS'}elseif(-not $admin){'WINDOWS_NOT_ADMIN'}else{'OK'})}; exit 0
  }
  if ($exists) { Emit @{phase='failed';code='ACCOUNT_EXISTS'}; exit 1 }
  if (-not $admin) { Emit @{phase='failed';code='WINDOWS_NOT_ADMIN'}; exit 1 }
  if ($request.password -isnot [string] -or $request.password.Length -lt 32 -or $request.password -match '[\x00-\x20]') { throw 'input' }
  $password=ConvertTo-SecureString -String $request.password -AsPlainText -Force
  $request.password=$null
  $phase='creating'; Emit @{phase=$phase}
  $user=New-LocalUser -Name $request.username -Password $password -Description 'Agent GUI session account' -ErrorAction Stop
  $password.Dispose(); $password=$null
  $sid=$user.SID.Value
  $phase='created'; Emit @{phase=$phase;sid=$sid}
  Add-LocalGroupMember -SID 'S-1-5-32-555' -Member $user -ErrorAction Stop
  $phase='group_added'; Emit @{phase=$phase;sid=$sid}
  $member=@(Get-LocalGroupMember -SID 'S-1-5-32-555' | Where-Object {$_.SID.Value -eq $sid}).Count -eq 1
  $administrator=@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object {$_.SID.Value -eq $sid}).Count -gt 0
  if (-not $member -or $administrator) { throw 'membership' }
  Emit @{phase='complete';sid=$sid;domain=$env:COMPUTERNAME}; exit 0
} catch {
  Emit @{phase='failed';code='WINDOWS_FAILED';sid=$sid}; exit 1
} finally {
  if ($password) { $password.Dispose() }
  $request=$null
}
`;

export function createWindowsProvisionPort({ runtime, target, timeoutMs = 60_000 }) {
  const command = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '
    + Buffer.from(WINDOWS_PROVISION_SOURCE, 'utf16le').toString('base64');
  return async ({ mode, username, password, onStage = async () => {} }) => {
    const beforeDispatch = () => target.verify();
    let lease, timer, buffer = '', last, problem, processing = Promise.resolve(), received = 0;
    try {
      target.verify();
      lease = await runtime.openDesktopProcessChannel(target.writeProfile, { command, beforeDispatch });
      lease.stderr.on('data', () => {}); // Never print, retain or attach remote diagnostics to errors.
      lease.stream.on('data', chunk => {
        received += chunk.length;
        if (received > 16_384) { problem = true; lease.close(); return; }
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          processing = processing.then(async () => {
            let event;
            try { event = JSON.parse(line); } catch { fail('REMOTE_OUTCOME_UNKNOWN'); }
            if (!event || !phases.has(event.phase) || Object.keys(event).some(k => !['phase', 'sid', 'domain', 'accountExists', 'ready', 'code'].includes(k))
                || event.sid != null && !sidPattern.test(event.sid) || event.domain !== undefined && !/^[A-Za-z0-9_-]{1,63}$/.test(event.domain)
                || event.code !== undefined && !['OK', 'ACCOUNT_EXISTS', 'WINDOWS_NOT_ADMIN', 'WINDOWS_UNAVAILABLE', 'WINDOWS_FAILED'].includes(event.code)) fail('REMOTE_OUTCOME_UNKNOWN');
            last = event; await onStage(event);
          }).catch(() => { problem = true; });
        }
      });
      const bytes = Buffer.from(JSON.stringify({ mode, username, ...(mode === 'apply' ? { password } : {}) }) + '\n');
      await new Promise((resolve, reject) => lease.stream.end(bytes, error => { bytes.fill(0); error ? reject(error) : resolve(); }));
      const result = await Promise.race([lease.exitPromise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'REMOTE_OUTCOME_UNKNOWN' })), timeoutMs);
      })]);
      await processing;
      if (problem || buffer.trim() || !last || result.reason !== 'exit' || result.remoteState !== 'exited' || !result.cleanupComplete) fail('REMOTE_OUTCOME_UNKNOWN');
      if (last.phase === 'failed') fail(last.code);
      if (result.exitCode !== 0 || last.phase !== (mode === 'probe' ? 'probe' : 'complete')) fail('REMOTE_OUTCOME_UNKNOWN');
      if (mode === 'probe' && (typeof last.accountExists !== 'boolean' || typeof last.ready !== 'boolean')) fail('REMOTE_OUTCOME_UNKNOWN');
      if (mode === 'apply' && (!sidPattern.test(last.sid) || !last.domain)) fail('REMOTE_OUTCOME_UNKNOWN');
      return last;
    } catch (error) {
      if (safeCodes.has(error?.code)) throw error;
      fail('REMOTE_OUTCOME_UNKNOWN');
    } finally { clearTimeout(timer); try { await lease?.close(); } catch {} }
  };
}

async function defaultRuntime(env) {
  const [{ parseSettings }, { resolveTargets }, { createSshRuntime }] = await Promise.all([
    import('../src/adapters/config/settings.mjs'), import('../src/adapters/config/targets.mjs'), import('../src/adapters/ssh/vendor.mjs'),
  ]);
  const settings = parseSettings(env), runtime = await createSshRuntime({ ...env, BRIDGE_HOST_KEY_MODE: 'strict' });
  return { settings, runtime, targets: resolveTargets(settings, runtime.registry) };
}

async function exists(location) { try { await fs.lstat(location); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function privateDirectory(location) {
  const info = await fs.lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o700 || await fs.realpath(location) !== location) fail('UNSAFE_STORE');
}
async function syncDirectory(location) { const file = await fs.open(location, 'r'); try { await file.sync(); } finally { await file.close(); } }
async function exclusiveFile(location, value) {
  const file = await fs.open(location, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  await syncDirectory(path.dirname(location));
}
async function appendState(directory, state) {
  const file = await fs.open(path.join(directory, 'state.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); } finally { await file.close(); }
}
function publicState(value) {
  return { target: value.target, targetRevision: value.targetRevision, username: value.username, reference: value.reference,
    operationId: value.operationId, stage: value.stage, accountSid: value.accountSid ?? null, accountState: value.accountState ?? 'not_created',
    secretState: value.secretState ?? 'not_created', ...(value.code ? { code: value.code } : {}), automaticRetry: false };
}

/** Dry-run is read-only. Only explicit --apply creates state, credentials or an account. */
export async function runProvisionGuiAccount(args, { env = process.env, loadRuntime = defaultRuntime,
  windowsPort = createWindowsProvisionPort, passwordFactory = generateGuiPassword, write = value => console.log(JSON.stringify(value)) } = {}) {
  const options = parseProvisionArgs(args);
  let context, state, stateDirectory;
  try {
    context = await loadRuntime(env);
    const { settings, runtime, targets } = context;
    const directory = settings.secretStoreDir;
    if (!directory) fail('SECRET_STORE_UNCONFIGURED');
    if (options.store && options.store !== directory) fail('SECRET_STORE_MISMATCH');
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || process.platform !== 'linux') fail('UNSAFE_STORE');
    const target = targets.find(t => t.id === options.target);
    if (!target || target.platform !== 'windows' || !target.enabled || !target.identity
        || !runtime.registry.getProfile(target.writeProfile)?.trustedHostKey) fail('INVALID_TARGET');
    const verify = () => {
      try { target.verify(); } catch { fail('TARGET_CHANGED'); }
      if (target.revision !== options.revision) fail('TARGET_CHANGED');
    };
    verify();
    const referenceName = parseSecretReference(options.reference).name;
    const finalPath = path.join(directory, referenceName + '.json');
    const accountLock = path.join(directory, '.gui-account-' + hash(target.id + ':' + options.username));
    const secretLock = path.join(directory, '.gui-secret-' + hash(referenceName));
    const store = createLocalSecretStore(directory), service = createSecretService({ 'local-file': store });
    const rootExists = await exists(directory);
    if (rootExists) await privateDirectory(directory); else await privateDirectory(path.dirname(directory));
    if (options.status) {
      stateDirectory = path.join(directory, '.gui-operation-' + options.status);
      await privateDirectory(stateDirectory);
      const file = await fs.open(path.join(stateDirectory, 'state.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let text;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o600 || info.size > 65536) fail('UNSAFE_STORE');
        text = await file.readFile('utf8');
      } finally { await file.close(); }
      state = JSON.parse(text.trim().split('\n').at(-1));
      if (state.target !== target.id || state.targetRevision !== options.revision || state.reference !== options.reference || state.username !== options.username) fail('TARGET_CHANGED');
      const result = publicState(state); write(result); return result;
    }
    if (await exists(finalPath)) fail('SECRET_EXISTS');
    if (await exists(accountLock) || await exists(secretLock)) fail('PROVISION_RECOVERY_REQUIRED');
    if (rootExists) await service.describe(options.reference); // Checks existing provider root; never reads a colliding value.
    const remote = windowsPort({ runtime, target: { ...target, verify } });
    const probe = await remote({ mode: 'probe', username: options.username });
    if (probe.accountExists) fail('ACCOUNT_EXISTS');
    if (!probe.ready) fail(probe.code === 'WINDOWS_NOT_ADMIN' ? probe.code : 'WINDOWS_UNAVAILABLE');
    if (!options.apply) {
      const result = { target: target.id, targetRevision: target.revision, username: options.username, reference: options.reference,
        stage: 'dry_run', ready: true, accountExists: false, secretExists: false, storeInitializationRequired: !rootExists };
      write(result); return result;
    }
    verify();
    await store.init();
    if (await exists(finalPath)) fail('SECRET_EXISTS');
    const operationId = randomUUID();
    state = { target: target.id, targetRevision: target.revision, username: options.username, reference: options.reference,
      operationId, stage: 'reserved', accountState: 'not_created', secretState: 'not_created' };
    stateDirectory = path.join(directory, '.gui-operation-' + operationId);
    await fs.mkdir(stateDirectory, { mode: 0o700 });
    await exclusiveFile(path.join(stateDirectory, 'state.jsonl'), JSON.stringify(state) + '\n');
    await exclusiveFile(accountLock, operationId + '\n');
    await exclusiveFile(secretLock, operationId + '\n');
    const stagingDirectory = path.join(stateDirectory, 'credential');
    const staging = createLocalSecretStore(stagingDirectory);
    await staging.init();
    let password = passwordFactory();
    if (typeof password !== 'string' || !/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9])[\x21-\x7e]{32,128}$/.test(password)) fail('LOCAL_STATE_FAILED');
    await createSecretService({ 'local-file': staging }).put(options.reference, JSON.stringify({ username: options.username, domain: probe.domain, password }));
    state.secretState = 'staged_private'; state.stage = 'credential_staged'; await appendState(stateDirectory, state);
    verify();
    state.stage = 'dispatching'; state.accountState = 'unknown'; await appendState(stateDirectory, state);
    const completion = await remote({ mode: 'apply', username: options.username, password, onStage: async event => {
      if (event.sid) { state.accountSid = event.sid; state.accountState = 'created'; }
      state.stage = 'windows_' + event.phase;
      await appendState(stateDirectory, state);
    } });
    password = undefined;
    if (!sidPattern.test(completion.sid) || completion.domain !== probe.domain) fail('REMOTE_OUTCOME_UNKNOWN');
    verify();
    state.accountSid = completion.sid; state.accountState = 'created'; state.stage = 'publishing'; await appendState(stateDirectory, state);
    // Existing put() replaces records. Publish the staged provider record without replacing any final path.
    // A reader may briefly reject nlink=2. It never receives a partial record or another credential.
    try {
      await fs.link(path.join(stagingDirectory, referenceName + '.json'), finalPath);
      await syncDirectory(directory);
      state.secretState = 'linked_pending_unlink'; await appendState(stateDirectory, state);
      await fs.unlink(path.join(stagingDirectory, referenceName + '.json'));
      await syncDirectory(stagingDirectory); await syncDirectory(directory);
      await service.describe(options.reference);
    } catch (error) { fail(error.code === 'EEXIST' ? 'SECRET_EXISTS' : 'PUBLISH_FAILED'); }
    state.secretState = 'published'; state.stage = 'complete'; await appendState(stateDirectory, state);
    const result = publicState(state); write(result); return result;
  } catch (error) {
    const code = safeError(error);
    if (state && stateDirectory) {
      state.code = code; state.stage = 'stopped';
      try { await appendState(stateDirectory, state); } catch { /* Existing durable dispatch/state remains authoritative; no replay. */ }
    }
    const result = state ? publicState(state) : { target: options.target, targetRevision: options.revision,
      username: options.username, reference: options.reference, stage: 'stopped', code, automaticRetry: false };
    write(result); return result;
  } finally { try { await context?.runtime.registry.closeAll(); } catch {} }
}

if (import.meta.main) {
  try { const result = await runProvisionGuiAccount(process.argv.slice(2)); if (result.code) process.exitCode = 1; }
  catch { console.error(JSON.stringify({ stage: 'stopped', code: 'INVALID_ARGUMENTS', automaticRetry: false })); process.exitCode = 1; }
}
