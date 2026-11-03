// Standalone CI evidence capture; adapted from AGS engineering-practices (MIT).
// Only the two fixed suites below can run. This is not a sandbox or host attestation.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { lstatSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const suites = { path: 'test/test-mode-file-path-policy.test.mjs', app: 'test/test-mode-file-policy-application.test.mjs' };
const scopeFiles = [
  '.github/workflows/linux-regression.yml', '.github/workflows/windows-ssh.yml', 'app.mjs',
  'package.json', 'package-lock.json', 'scripts/capture-testmode-evidence.mjs',
  'src/adapters/config/targets.mjs', 'src/adapters/mcp/server.mjs', 'src/adapters/presentation/results.mjs',
  'src/adapters/ssh/transfers.mjs', 'src/adapters/ssh/vendor.mjs', 'src/adapters/storage/artifacts.mjs',
  'src/adapters/storage/command-state.mjs', 'src/application/target-router.mjs', 'src/application/test-server-mode.mjs',
  'src/contracts/ports.mjs', 'src/domain/file-target-binding.mjs', 'src/domain/validation.mjs',
  suites.path, suites.app,
].sort();
const hashBytes = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonicalJson = value => Array.isArray(value) ? '[' + value.map(canonicalJson).join(',') + ']'
  : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  : JSON.stringify(value);
const seal = value => ({ ...value, digest: hashBytes(canonicalJson(value)) });
const root = resolve('.');
const snapshot = () => {
  let total = 0;
  const files = scopeFiles.map(path => {
    let current = root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !(i === parts.length - 1 ? st.isFile() : st.isDirectory())) throw Error('Unsafe declared snapshot path');
    }
    const bytes = readFileSync(current);
    total += bytes.length;
    if (bytes.length > 8 * 1024 * 1024 || total > 64 * 1024 * 1024) throw Error('Declared snapshot exceeds bounds');
    const text = isUtf8(bytes) && !bytes.includes(0) ? bytes.toString('utf8') : null;
    const lineCount = text === null || text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { path, digest: hashBytes(bytes), size: bytes.length, lineCount };
  });
  return seal({ schemaVersion: '1.0.0', kind: 'engineering-snapshot', files });
};

const [output, suite, ...extra] = process.argv.slice(2);
if (!output || extra.length || !Object.hasOwn(suites, suite)) throw Error('Usage: node scripts/capture-testmode-evidence.mjs RECEIPT_PATH path|app');
const argv = ['node', '--test', '--test-reporter=tap', suites[suite]], timeoutMs = 300000;
const before = snapshot(), startedAt = new Date().toISOString();
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const child = spawnSync(argv[0], argv.slice(1), { cwd: root, shell: false, env: childEnv, timeout: timeoutMs,
  killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const finishedAt = new Date().toISOString();
let afterDigest;
try { afterDigest = snapshot().digest; }
catch { afterDigest = hashBytes('Snapshot became unreadable after command execution.'); }
const stdout = child.stdout ?? '', stderr = child.stderr ?? '';
const status = afterDigest !== before.digest ? 'INPUT_CHANGED' : child.error?.code === 'ETIMEDOUT' ? 'TIMED_OUT'
  : child.error || child.signal ? 'SPAWN_ERROR' : child.status === 0 ? 'PASS' : 'FAIL';
const receipt = seal({ schemaVersion: '1.0.0', kind: 'engineering-run-receipt', argv, snapshot: before, afterDigest,
  startedAt, finishedAt, status, exitCode: child.status ?? null, signal: child.signal ?? null, stdout, stderr,
  stdoutDigest: hashBytes(stdout), stderrDigest: hashBytes(stderr), timeoutMs, executable: argv[0],
  nodeVersion: process.versions.node, platform: process.platform,
  environmentNote: 'GitHub Actions pinned Node 24.21.0; inherited runner environment; child NODE_TEST_CONTEXT cleared; only declared source files snapshotted.' });
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(stdout); process.stderr.write(stderr);
console.log(`EVIDENCE_STATUS=${status} EVIDENCE_EXIT=${child.status ?? 'null'} EVIDENCE_DIGEST=${receipt.digest}`);
process.exitCode = status === 'PASS' ? 0 : status === 'FAIL' ? child.status : 2;
