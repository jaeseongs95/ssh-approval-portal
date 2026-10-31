/** Platform selection is administrator-owned and bound by the target revision. */
export const platformOf = target => target?.platform ?? 'linux';

export function targetCapabilities(target) {
  const windows = platformOf(target) === 'windows';
  return Object.freeze({ commandShell: windows ? 'windows-powershell-5.1' : 'posix',
    fileTransfer: true, elevatedFileTransfer: !windows, pythonSource: !windows, agentCli: !windows,
    commandNameApproval: !windows });
}

const prefix = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$ErrorActionPreference='Stop';$global:LASTEXITCODE=0;try { & { ";
// Finish PowerShell's object formatting before exit; otherwise PathInfo/table
// output can still be queued when the process terminates.
const suffix = "\n} | Microsoft.PowerShell.Core\\Out-Default;exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message);exit 1 }";
const readModule = command => /^(Microsoft\.PowerShell\.(?:Utility|Management))\\(?:Get-Date|Get-Location)$/i.exec(command.trim())?.[1];

export function wrapWindowsCommand(command) {
  if (typeof command !== 'string' || !command.trim() || !command.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/.test(command)) throw Error('Invalid Windows command');
  const module = readModule(command);
  // A qualified name still autoloads through user PSModulePath. Pin the two
  // read-only modules to the trusted PowerShell installation before execution.
  const readPrelude = module ? `$PSModuleAutoLoadingPreference='None';Microsoft.PowerShell.Core\\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','${module}','${module}.psd1')) -Force -ErrorAction Stop;` : '';
  const encoded = Buffer.from(prefix + readPrelude + command + suffix, 'utf16le').toString('base64');
  const wrapped = `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -InputFormat Text -OutputFormat Text -EncodedCommand ${encoded}`;
  // Windows OpenSSH commonly starts cmd.exe: refuse before approval, never truncate.
  if (wrapped.length > 8000) throw Object.assign(Error('Windows command exceeds the encoded shell limit'), { code: 'WINDOWS_COMMAND_TOO_LARGE' });
  return wrapped;
}

export function classifyForTarget(target, classify) {
  if (platformOf(target) !== 'windows') return classify;
  return command => {
    wrapWindowsCommand(command);
    // Module qualification avoids aliases, profiles and PATH command substitution.
    const readOnly = /^(?:Microsoft\.PowerShell\.Utility\\Get-Date|Microsoft\.PowerShell\.Management\\Get-Location)$/i.test(command.trim());
    return { class: readOnly ? 'read-only' : 'safe' };
  };
}

export function requireTargetCapability(target, capability) {
  if (targetCapabilities(target)[capability] !== true) {
    throw Object.assign(Error(`Target platform does not support ${capability}`), { code: 'TARGET_CAPABILITY_UNSUPPORTED' });
  }
}

export function deniedForTarget(target, command, rule, fallback) {
  if (platformOf(target) !== 'windows') return fallback(command, rule);
  // This is a deny hint, not a PowerShell parser or proof that arbitrary code is safe.
  const words = command.toLowerCase().split(/[^a-z0-9_.+-]+/);
  return Boolean(rule?.deniedCommands.some(name => words.includes(name.toLowerCase())));
}
