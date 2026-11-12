import hashlib,os,sys,types
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
 sys.stderr.write('Source compilation or working directory rejected\n')
 sys.exit(126)
sys.argv=['<ssh-python-source-v1>',*sys.argv[4:]]
m=types.ModuleType('__main__')
m.__package__=None
m.__spec__=None
sys.modules['__main__']=m
exec(c,m.__dict__)
