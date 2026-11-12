import hashlib,json,os,sys,types
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
n=int(sys.argv[1])
if not 0<n<=24576: sys.exit(125)
b=sys.stdin.buffer.read(n+1)
if len(b)!=n or hashlib.sha256(b).hexdigest()!=sys.argv[2]: sys.exit(125)
try:
 p=b.index(b'\n')+1
 h=int(b[:p])
 if not 0<h<=8192: raise ValueError()
 v=json.loads(b[p:p+h].decode('utf-8','strict'))
 b=b[p+h:]
 if not 0<len(b)<=16384 or len(b)!=v['sourceBytes'] or hashlib.sha256(b).hexdigest()!=v['sourceSha256']: raise ValueError()
except Exception: sys.exit(125)
if v['elevate']:
 import ctypes
 if not ctypes.windll.shell32.IsUserAnAdmin():
  sys.stderr.write('Administrator connection token required\n')
  sys.exit(126)
keys='SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','PROGRAMDATA'
env={k:v for k,v in os.environ.items() if k.upper() in {x.upper() for x in keys}}
root=os.environ.get('SystemRoot','')
if not root: sys.exit(125)
env['PATH']=os.path.dirname(sys.executable)+';'+root+'\\System32;'+root
os.environ.clear()
os.environ.update(env)
try:
 c=compile(b.decode('utf-8','strict'),'<ssh-python-source-v1>','exec',dont_inherit=True)
 os.chdir(v['cwd'])
except Exception:
 sys.stderr.write('Source compilation or cwd rejected\n')
 sys.exit(126)
sys.argv=['<ssh-python-source-v1>',*v['argv']]
m=types.ModuleType('__main__')
sys.modules['__main__']=m
exec(c,m.__dict__)
