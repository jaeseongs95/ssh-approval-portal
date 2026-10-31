import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;
// CreateProcess 인수는 문자열이므로 따옴표와 마지막 역슬래시까지 인용한다.
const quoteArgument = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const environmentPolicy = JSON.stringify({
  inherit: ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA'],
  path: 'interpreter-directory;SystemRoot\\System32;SystemRoot',
});
export const WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION = digest(environmentPolicy);

const receiverFor = maxBytes => `import hashlib,os,sys,types
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
n=int(sys.argv[1])
if not 0<n<=${maxBytes}: sys.exit(125)
b=sys.stdin.buffer.read(n+1)
if len(b)!=n or hashlib.sha256(b).hexdigest()!=sys.argv[2]: sys.exit(125)
keys=${JSON.parse(environmentPolicy).inherit.map(key => `'${key}'`).join(',')}
env={k:v for k,v in os.environ.items() if k.upper() in {x.upper() for x in keys}}
root=os.environ.get('SystemRoot','')
if not root: sys.exit(125)
env['PATH']=os.path.dirname(sys.executable)+';'+root+'\\\\System32;'+root
os.environ.clear()
os.environ.update(env)
try:
 c=compile(b.decode('utf-8','strict'),'<ssh-python-source-v1>','exec',dont_inherit=True)
 os.chdir(sys.argv[3])
except Exception:
 sys.stderr.write('Source compilation or working directory rejected\\n')
 sys.exit(126)
sys.argv=['<ssh-python-source-v1>',*sys.argv[4:]]
m=types.ModuleType('__main__')
m.__package__=None
m.__spec__=None
sys.modules['__main__']=m
exec(c,m.__dict__)
`;

function absolutePath(value) {
  return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= 512
    && /^[A-Za-z]:[\\/]/.test(value) && !/[\0\r\n"<>|?*]/.test(value)
    && !value.slice(2).includes(':') && !value.split(/[\\/]/).some(part => part === '.' || part === '..');
}

export function prepareWindowsPythonSource({ source, argv = [], cwd, elevate = false, targetId, targetRevision, profile,
  platform, pythonExecutable, environmentRevision = WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION }, maxBytes) {
  if (platform !== 'windows') throw Error('Explicit Windows source platform required');
  if (typeof elevate !== 'boolean') throw Error('Invalid source elevation');
  if (typeof source !== 'string' || !source.isWellFormed() || source.includes('\0')
    || !Buffer.byteLength(source) || Buffer.byteLength(source) > maxBytes) throw Error('Invalid Python source');
  if (!Array.isArray(argv) || argv.length > 16 || argv.some(value => typeof value !== 'string' || !value.isWellFormed()
    || Buffer.byteLength(value) > 512 || /[\0\r\n]/.test(value)) || Buffer.byteLength(JSON.stringify(argv)) > 4096) throw Error('Invalid source arguments');
  if (!absolutePath(cwd)) throw Error('Explicit absolute Windows source working directory required');
  if (!absolutePath(pythonExecutable) || !/[\\/]python(?:\d+(?:\.\d+)*)?\.exe$/i.test(pythonExecutable)) throw Error('Explicit absolute Python executable required');
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(targetId ?? '') || !/^[a-f0-9]{64}$/.test(targetRevision ?? '')
    || typeof profile !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(profile)
    || environmentRevision !== WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION) throw Error('Invalid source target binding');
  const receiver = receiverFor(maxBytes);
  const args = Object.freeze(['-I', '-B', '-S', '-X', 'utf8', '-c', receiver, String(Buffer.byteLength(source)), digest(source), cwd, ...argv]);
  // 원문은 문자열 파이프와 StreamWriter를 피하고 바이트로만 복사한다.
  // 표준 출력·오류는 SSH 핸들을 상속하고 표준 입력만 별도로 연결한다.
  const launcher = `$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';try{`
    + (elevate ? `if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){[Console]::Error.Write('Administrator connection token required');exit 126};` : '')
    + `$s=[Diagnostics.ProcessStartInfo]::new();$s.FileName=${quotePowerShell(pythonExecutable)};$s.Arguments=${quotePowerShell(args.map(quoteArgument).join(' '))};`
    + `if(-not [IO.File]::Exists($s.FileName)){[Console]::Error.Write('Configured Python executable unavailable');exit 127};`
    + `$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$s.RedirectStandardInput=$true;$p=[Diagnostics.Process]::Start($s);`
    + `try{[Console]::OpenStandardInput().CopyTo($p.StandardInput.BaseStream)}finally{$p.StandardInput.BaseStream.Close()};$p.WaitForExit();exit $p.ExitCode`
    + `}catch{[Console]::Error.Write('Python source launcher failed');exit 125}`;
  const command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '
    + Buffer.from(launcher, 'utf16le').toString('base64');
  if (command.length > 8000) throw Error('Source execution command too large');
  const manifest = Object.freeze({ contract: 'python-source-v1', platform, interpreter: pythonExecutable,
    startupFlags: '-I -B -S -X utf8', receiverSha256: digest(receiver), launcherSha256: digest(launcher),
    sourceSha256: digest(source), sourceBytes: Buffer.byteLength(source), argvJson: JSON.stringify(argv),
    cwd, elevate, targetId, targetRevision, profile, environmentRevision, environmentPolicy });
  return Object.freeze({ manifest, planDigest: digest(JSON.stringify(manifest)), command, args, stdin: source });
}
