import { createHash } from 'node:crypto';

export const PYTHON_SOURCE_CONTRACT = 'python-source-v1';
export const PYTHON_SOURCE_MAX_BYTES = 16_384;
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const environment = Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' });
export const PYTHON_SOURCE_ENVIRONMENT_REVISION = digest(JSON.stringify(environment));

// The receiver reads through EOF before executing the verified buffer. This is
// transport integrity, not a sandbox, effect proof, or execution authority.
const receiver = `import hashlib,os,sys,types
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
n=int(sys.argv[1])
if not 0<n<=16384: sys.exit(125)
b=sys.stdin.buffer.read(n+1)
if len(b)!=n or hashlib.sha256(b).hexdigest()!=sys.argv[2]: sys.exit(125)
os.environ.clear()
os.environ.update({'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PATH':'/usr/bin:/bin'})
try:
 s=b.decode('utf-8','strict')
 c=compile(s,'<ssh-python-source-v1>','exec',dont_inherit=True)
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

/** Dormant transport primitive: callers must separately authorize, disclose,
 * retain, and dispatch this plan with a verified non-TTY SSH profile. The public
 * manifest identifies a requested plan; it does not attest the remote runtime.
 * Legacy command execution and command-name bypass do not consume this type.
 */
export function preparePythonSource({ source, argv = [], cwd, elevate = false, targetId, targetRevision, profile, environmentRevision = PYTHON_SOURCE_ENVIRONMENT_REVISION }) {
  if (typeof elevate !== 'boolean') throw Error('Invalid source elevation');
  if (typeof source !== 'string' || !source.isWellFormed() || source.includes('\0')
    || !Buffer.byteLength(source) || Buffer.byteLength(source) > PYTHON_SOURCE_MAX_BYTES) throw Error('Invalid Python source');
  if (!Array.isArray(argv) || argv.length > 16 || argv.some(value => typeof value !== 'string' || !value.isWellFormed()
    || Buffer.byteLength(value) > 512 || /[\0\r\n]/.test(value)) || Buffer.byteLength(JSON.stringify(argv)) > 4096) throw Error('Invalid source arguments');
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || !cwd.isWellFormed() || Buffer.byteLength(cwd) > 512
    || /[\0\r\n]/.test(cwd)) throw Error('Explicit absolute source working directory required');
  if (![targetId, targetRevision, profile, environmentRevision].every(value => typeof value === 'string')
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(targetId ?? '') || !/^[a-f0-9]{64}$/.test(targetRevision ?? '')
    || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(profile ?? '') || environmentRevision !== PYTHON_SOURCE_ENVIRONMENT_REVISION) throw Error('Invalid source target binding');
  const manifest = Object.freeze({ contract: PYTHON_SOURCE_CONTRACT, interpreter: '/usr/bin/python3', startupFlags: '-I -B -S -X utf8',
    receiverSha256: digest(receiver), sourceSha256: digest(source), sourceBytes: Buffer.byteLength(source),
    argvJson: JSON.stringify(argv), cwd, elevate, targetId, targetRevision, profile, environmentRevision,
    environmentPolicy: JSON.stringify(environment) });
  const args = Object.freeze(['-I', '-B', '-S', '-X', 'utf8', '-c', receiver, String(manifest.sourceBytes), manifest.sourceSha256, cwd, ...argv]);
  const command = [...(elevate ? ['sudo', '-n', '--'] : []), manifest.interpreter, ...args].map(quote).join(' ');
  if (command.length > 2000) throw Error('Source execution command too large');
  return Object.freeze({ manifest, planDigest: digest(JSON.stringify(manifest)), command, args, stdin: source });
}
