import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';
import { redactText } from 'ssh-mcp/build/guard/redactor.js';
import { executionFailure } from '../../domain/execution-failure.mjs';

const helperPrefix = '/usr/bin/python3 -I -B -S -X utf8 -c ';
const failure = (reason, notStarted = false) => {
  const error = executionFailure(Error(), { stage: 'operation', code: 'OPERATION_FAILED', remoteOutcome: notStarted ? 'not_started' : 'unknown' });
  error.message = `Local desktop helper ${reason}`;
  return error;
};

/** Internal fixed-product helper only. Bootstrap and authentication bytes travel
 * through stdin; they never become command arguments, environment or diagnostics. */
export async function openLocalDesktopProcess({ command, signal, beforeDispatch = async () => {} } = {}) {
  if (process.platform !== 'linux') throw failure('requires a Linux relay', true);
  if (typeof command !== 'string' || !command.startsWith(helperPrefix) || command.includes('\0') || typeof beforeDispatch !== 'function') throw failure('invalid fixed helper command', true);
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw failure('invalid cancellation signal', true);
  if (signal?.aborted) throw failure('cancelled before dispatch', true);
  await beforeDispatch();
  beforeDispatch.verify?.();
  if (signal?.aborted) throw failure('cancelled before dispatch', true);
  return new Promise((resolve, reject) => {
    // Do not spread process.env: this child must not inherit server credentials.
    const child = spawn('/bin/sh', ['-c', `exec ${command}`], { cwd: '/', detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const stderr = new PassThrough({ highWaterMark: 16 * 1024 }), captured = [];
    let started = false, settled = false, exitSeen = false, closed = false, exitCode = null, exitSignal = null, reason;
    let receivedBytes = 0, retainedBytes = 0, cleanupTimer, killTimer, deadline;
    let resolveExit;
    const exitPromise = new Promise(done => { resolveExit = done; });
    const groupAlive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return error.code !== 'ESRCH'; }
    };
    const signalGroup = name => {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); }
      catch (error) { if (error.code !== 'ESRCH') reason ??= 'signal_failed'; }
    };
    const finish = cleanupComplete => {
      if (settled) return;
      settled = true; clearTimeout(cleanupTimer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort); stderr.end();
      const outcome = reason ?? (exitSeen ? 'exit' : 'close');
      const error = outcome === 'exit' && exitCode === 0 && !exitSignal && cleanupComplete ? undefined : failure(outcome);
      resolveExit({ exitCode, signal: exitSignal, reason: outcome, remoteState: exitSeen ? 'exited' : 'unknown', cleanupComplete,
        ...(error ? { error } : {}), stderr: { text: redactText(Buffer.concat(captured).toString('utf8'), { entropyScan: true }),
          receivedBytes, retainedBytes, truncated: receivedBytes > retainedBytes } });
      stream.destroy();
    };
    const checkCleanup = () => {
      if (settled) return;
      if (closed && !groupAlive()) { finish(true); return; }
      if (Date.now() >= deadline) { reason ??= 'cleanup_timeout'; finish(false); return; }
      cleanupTimer = setTimeout(checkCleanup, 20);
    };
    const beginCleanup = () => {
      if (deadline || settled) return;
      // Allow TERM cleanup, then force only this process group. A second bounded
      // observation window preserves unknown cleanup rather than claiming exit.
      deadline = Date.now() + 2000;
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 1000);
      checkCleanup();
    };
    const stop = value => {
      if (settled || reason) return exitPromise;
      reason = value;
      try { child.stdin.end(); } catch { reason = 'input_failed'; }
      signalGroup('SIGTERM'); beginCleanup();
      return exitPromise;
    };
    const onAbort = () => stop('cancel');
    // Keep error handlers after settlement so late pipe/child errors cannot
    // become uncaught exceptions or replace the already observed result.
    stream.on('error', () => { if (!exitSeen) stop('channel_error'); });
    child.stdin.on('error', () => { if (!exitSeen) stop('input_failed'); });
    child.stderr.on('error', () => stop('channel_error'));
    child.stderr.on('data', bytes => {
      if (settled) return;
      receivedBytes += bytes.length;
      const keep = bytes.subarray(0, Math.max(0, 16 * 1024 - retainedBytes));
      if (keep.length) { captured.push(Buffer.from(keep)); retainedBytes += keep.length; stderr.write(keep); }
      if (receivedBytes > 16 * 1024) stop('stderr_limit');
    });
    child.on('error', () => {
      if (!started) {
        settled = true; clearTimeout(cleanupTimer); clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort); stderr.destroy(); stream.destroy();
        reject(failure('spawn failed', true));
      } else stop('channel_error');
    });
    child.once('exit', (code, value) => {
      exitSeen = true; exitCode = Number.isInteger(code) ? code : null; exitSignal = value ?? null;
      // The leader can exit while a descendant still holds pipes or runs. EOF
      // from the helper is not authority to leave that process group behind.
      if (groupAlive()) signalGroup('SIGTERM');
      beginCleanup();
    });
    child.once('close', () => { closed = true; beginCleanup(); if (!settled && !groupAlive()) finish(true); });
    child.once('spawn', () => {
      started = true;
      if (signal?.aborted) { stop('cancel'); reject(failure('cancel')); return; }
      resolve({ stream, stderr, close: () => stop('close'), exitPromise });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
