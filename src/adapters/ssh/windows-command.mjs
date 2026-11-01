import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { utf8WithinLimit } from '../../contracts/ports.mjs';
import { validateWindowsCommand } from '../../domain/target-platform.mjs';
import { WINDOWS_STDIN_READER } from './windows-stdin.mjs';

const prefix = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$ErrorActionPreference='Stop';$global:LASTEXITCODE=0;try { & { ";
// Finish PowerShell's object formatting before exit; otherwise PathInfo/table
// output can still be queued when the process terminates.
const suffix = "\n} | Microsoft.PowerShell.Core\\Out-Default;exit $LASTEXITCODE } catch { [Console]::Error.WriteLine('Windows command failed');exit 1 }";
const readModule = command => /^Microsoft\.PowerShell\.Utility\\Get-Date$/i.test(command.trim()) ? 'Microsoft.PowerShell.Utility'
  : /^Microsoft\.PowerShell\.Management\\Get-Location$/i.test(command.trim()) ? 'Microsoft.PowerShell.Management' : null;
const importModule = (module, disableAutoLoad = true) => `${disableAutoLoad ? "$PSModuleAutoLoadingPreference='None';" : ''}Microsoft.PowerShell.Core\\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','${module}','${module}.psd1')) -Force -ErrorAction Stop;`;
const launcher = (script, compressed = false) => {
  if (compressed) {
    const encoded = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
    // 고정 수신기를 압축해 작업 폴더와 네이티브 준비문을 포함해도 셸 상한을 지킨다.
    script = `try{$z=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${encoded}')),[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($z,[Text.UTF8Encoding]::new($false,$true));try{$s=$r.ReadToEnd()}finally{$r.Dispose()};& ([ScriptBlock]::Create($s))}catch{[Console]::Error.WriteLine('Windows command failed');exit 125}`;
  }
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -InputFormat Text -OutputFormat Text -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  if (command.length > 8000) throw Object.assign(Error('Windows command exceeds the encoded shell limit'), { code: 'WINDOWS_COMMAND_TOO_LARGE' });
  return command;
};
function workingDirectoryPrelude(workdir) {
  if (workdir === undefined) return '';
  if (!utf8WithinLimit(workdir, 512) || !/^[a-z]:[\\/]/i.test(workdir) || /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff<>"|?*]/.test(workdir)
    || workdir.slice(2).includes(':') || workdir.split(/[\\/]/).slice(1).some(part => part === '.' || part === '..' || /[. ]$/.test(part))) throw Error('Invalid Windows working directory');
  // 경로의 곡선 따옴표도 PowerShell 구문으로 해석되지 않도록 데이터로 복원한다.
  const encoded = Buffer.from(workdir, 'utf8').toString('base64');
  return `${importModule('Microsoft.PowerShell.Management', false)}$workdir=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${encoded}'));Microsoft.PowerShell.Management\\Set-Location -LiteralPath $workdir -ErrorAction Stop;[IO.Directory]::SetCurrentDirectory($workdir);`;
}

export function wrapWindowsCommand(command) {
  validateWindowsCommand(command);
  const module = readModule(command);
  // A qualified name still autoloads through user PSModulePath. Pin the two
  // read-only modules to the trusted PowerShell installation before execution.
  return launcher(prefix + (module ? importModule(module) : '') + command + suffix);
}

/** The bounded receiver consumes exact UTF-8 bytes through EOF before compiling.
 * The digest binds transport bytes, not safety or execution authority. The caller
 * retains the raw command as its approval/output subject and sends stdin unchanged.
 */
export function prepareWindowsCommand(command, { workdir } = {}) {
  validateWindowsCommand(command);
  const bytes = Buffer.byteLength(command, 'utf8'), digest = createHash('sha256').update(command, 'utf8').digest('hex');
  const module = readModule(command);
  const prelude = workingDirectoryPrelude(workdir) + (module ? importModule(module) : '');
  const receiver = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$ErrorActionPreference='Stop';$global:LASTEXITCODE=0;$stage=125;try{`
    + WINDOWS_STDIN_READER
    + `$buffer=[Array]::CreateInstance([byte],${bytes + 1});$count=0;while($count -lt $buffer.Length){$read=[SshApproval.Stdin]::Read($buffer,$count,$buffer.Length-$count);if($read -eq 0){break};$count+=$read};if($count -ne ${bytes}){exit 125};`
    + `$hash=[Security.Cryptography.SHA256]::Create();try{$actual=[BitConverter]::ToString($hash.ComputeHash($buffer,0,$count)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()};if($actual -ne '${digest}'){exit 125};`
    + `$source=[Text.UTF8Encoding]::new($false,$true).GetString($buffer,0,$count);$stage=1;$code=[ScriptBlock]::Create($source);${prelude}& $code | Microsoft.PowerShell.Core\\Out-Default;exit $LASTEXITCODE`
    + `}catch{[Console]::Error.WriteLine('Windows command failed');exit $stage}`;
  return Object.freeze({ command: launcher(receiver, true), stdin: command });
}
