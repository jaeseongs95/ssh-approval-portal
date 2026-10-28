import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePythonSource, preparePythonHelper, PYTHON_SOURCE_MAX_BYTES, PYTHON_HELPER_MAX_BYTES, PYTHON_SOURCE_ENVIRONMENT_REVISION } from '../src/adapters/ssh/python-source.mjs';

const python = process.env.SOLID_PYTHON ?? (process.platform === 'win32'
  ? 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' : 'python3');
const binding = { cwd: '/', targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write', environmentRevision: PYTHON_SOURCE_ENVIRONMENT_REVISION };
const plan = (source, rest = {}) => preparePythonSource({ ...binding, source, ...rest });
const run = (p, input = p.stdin) => spawnSync(python, p.args, { input, encoding: 'utf8', timeout: 5000, windowsHide: true });
const absent = async file => assert.equal(await access(file).then(() => false, () => true), true, 'SOURCE-01: invalid body must have no marker effect');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-source-receiver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'marker.txt');
}

test('SOURCE-01 receiver rejects valid truncated prefix, wrong bytes, trailing data and UTF8 truncation before effects', async t => {
  const marker = await fixture(t);
  const prefix = "import pathlib,sys\npathlib.Path(sys.argv[1]).write_text('marker',encoding='utf-8')\n";
  const p = plan(prefix + "print('완료')\n", { argv: [marker] });
  const bytes = Buffer.from(p.stdin);
  const changed = Buffer.from(bytes); changed[changed.indexOf(Buffer.from('marker'))] = 120;
  for (const input of [Buffer.from(prefix), changed, Buffer.concat([bytes, Buffer.from('x')]), bytes.subarray(0, bytes.length - 5), Buffer.alloc(0)]) {
    const result = run(p, input); assert.ifError(result.error); await absent(marker); assert.equal(result.status, 125);
  }
  const invalidUtf8 = plan('x'.repeat(4));
  const wrongEncoding = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const alteredArgs = [...invalidUtf8.args];
  const { createHash } = await import('node:crypto');
  alteredArgs[alteredArgs.indexOf('-c') + 3] = createHash('sha256').update(wrongEncoding).digest('hex');
  const invalid = run({ ...invalidUtf8, args: alteredArgs }, wrongEncoding);
  assert.equal(invalid.status, 126); assert.doesNotMatch(invalid.stderr, /xff|Traceback/);
});

test('SOURCE-02 bare Python executes the same valid truncated prefix, establishing the regression mechanism', async t => {
  const marker = await fixture(t);
  const prefix = "import pathlib,sys\npathlib.Path(sys.argv[1]).write_text('marker',encoding='utf-8')\n";
  const result = spawnSync(python, ['-I', '-B', '-S', '-', marker], { input: prefix, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(await readFile(marker, 'utf8'), 'marker');
});

test('SOURCE-03 exact body, literal argv, module contract and EOF stdin support scratch change and recovery', async t => {
  const marker = await fixture(t), literal = "한글 ' $(touch ignored) ; &";
  const source = "import pathlib,sys,os,json\nassert '__file__' not in globals()\nassert sys.stdin.buffer.read()==b''\np=pathlib.Path(sys.argv[1])\np.write_text('changed',encoding='utf-8')\nassert p.read_text(encoding='utf-8')=='changed'\np.write_text('restored',encoding='utf-8')\nprint(json.dumps([sys.argv[0],sys.argv[2],os.getcwd(),__name__],ensure_ascii=False))\n";
  const p = plan(source, { argv: [marker, literal] }), result = run(p);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const values = JSON.parse(result.stdout);
  assert.deepEqual([values[0], values[1], values[3]], ['<ssh-python-source-v1>', literal, '__main__']);
  assert.equal(values[2].replaceAll('\\', '/').endsWith('/'), true);
  assert.equal(await readFile(marker, 'utf8'), 'restored');
});

test('SOURCE-04 complete bytes without EOF remain gated and then execute once after EOF', async t => {
  const marker = await fixture(t);
  const p = plan("import pathlib,sys\npathlib.Path(sys.argv[1]).write_text('once',encoding='utf-8')\n", { argv: [marker] });
  const child = spawn(python, p.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const deadline = setTimeout(() => child.kill(), 5000);
  t.after(() => { clearTimeout(deadline); if (child.exitCode === null) child.kill(); });
  child.stdout.resume(); child.stderr.resume();
  await new Promise((resolve, reject) => child.stdin.write(p.stdin, error => error ? reject(error) : resolve()));
  await new Promise(resolve => setTimeout(resolve, 200));
  await absent(marker); assert.equal(child.exitCode, null);
  child.stdin.end();
  assert.deepEqual(await finished, { code: 0, signal: null });
  assert.equal(await readFile(marker, 'utf8'), 'once');
});

test('SOURCE-05 public manifest is flat and source-free, private input immutable, every binding changes plan digest', () => {
  const argv = ['literal'], p = plan("print('private-source-marker')\n", { argv });
  argv[0] = 'changed'; assert.equal(p.manifest.argvJson, '["literal"]');
  assert.equal(Object.isFrozen(p), true); assert.equal(Object.isFrozen(p.manifest), true); assert.equal(Object.isFrozen(p.args), true);
  assert.doesNotMatch(JSON.stringify(p.manifest), /private-source-marker/);
  assert.equal(Object.values(p.manifest).every(v => ['number', 'string', 'boolean'].includes(typeof v)), true);
  assert.equal(p.manifest.sourceBytes, Buffer.byteLength(p.stdin));
  assert.equal(p.planDigest, plan(p.stdin, { argv: ['literal'] }).planDigest);
  for (const rest of [{ source: p.stdin + '\n' }, { argv: ['other'] }, { cwd: '/tmp' }, { targetId: 'other' },
    { targetRevision: 'c'.repeat(64) }, { profile: 'other' }, { elevate: true }]) {
    assert.notEqual(plan(p.stdin, { argv: ['literal'], ...rest }).planDigest, p.planDigest);
  }
});

test('SOURCE-06 bounded validated source/arguments/binding and literal shell quoting', () => {
  for (const source of ['', '\ud800', 'a\0b', 'x'.repeat(PYTHON_SOURCE_MAX_BYTES + 1), '한'.repeat(PYTHON_SOURCE_MAX_BYTES / 3 + 1)]) assert.throws(() => plan(source));
  for (const rest of [{ argv: ['\0'] }, { argv: ['\n'] }, { argv: Array(17).fill('x') }, { argv: ['x'.repeat(513)] },
    { cwd: 'relative' }, { cwd: '/x\n' }, { targetId: '../bad' }, { targetRevision: 'wrong' }, { environmentRevision: '' }, { environmentRevision: 'c'.repeat(64) }, { profile: 'bad;id' }, { profile: 1 }]) assert.throws(() => plan('pass\n', rest));
  assert.equal(plan('x'.repeat(PYTHON_SOURCE_MAX_BYTES)).manifest.sourceBytes, PYTHON_SOURCE_MAX_BYTES);
  const p = plan('pass\n', { argv: ["a'b", '$(id); &'] });
  assert.equal(p.command, ['/usr/bin/python3', ...p.args].map(v => "'" + v.replaceAll("'", "'\\''") + "'").join(' '));
  assert.ok(p.command.length <= 2000);
  assert.equal(plan('pass\n', { elevate: true }).command.startsWith("'sudo' '-n' '--' '/usr/bin/python3'"), true);
  assert.throws(() => plan('pass\n', { elevate: 'true' }), /elevation/);
  assert.throws(() => plan('pass\n', { argv: Array(3).fill('x'.repeat(512)) }), /too large/i);
  const compileFailed = run(plan("print('first')\nthis is ! invalid\n"));
  assert.equal(compileFailed.status, 126); assert.equal(compileFailed.stdout, ''); assert.doesNotMatch(compileFailed.stderr, /first|Traceback/);
  const helper = preparePythonHelper({ ...binding, source: 'x'.repeat(PYTHON_SOURCE_MAX_BYTES + 100) + '\n' });
  assert.equal(helper.manifest.sourceBytes, PYTHON_SOURCE_MAX_BYTES + 101);
  assert.notEqual(helper.manifest.receiverSha256, p.manifest.receiverSha256);
  assert.throws(() => preparePythonHelper({ ...binding, source: 'x'.repeat(PYTHON_HELPER_MAX_BYTES + 1) }));
});
