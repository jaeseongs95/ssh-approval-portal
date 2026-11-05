/** Own the command lifetime. The port only opens a channel and observes transport
 * loss; it never retries a dispatched command or interprets approval policy. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_STOP_GRACE_MS = 5_000;
export const DEFAULT_OUTPUT_BYTES = 1024 * 1024;

export function superviseExecution(port, command, { stdin, timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  stopGraceMs = DEFAULT_STOP_GRACE_MS, maxOutputBytes = DEFAULT_OUTPUT_BYTES, signal, onOutput } = {}) {
  for (const [name, value] of Object.entries({ timeoutMs, stopGraceMs, maxOutputBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw Error(`Invalid execution ${name}`);
  }
  if (stdin !== undefined && typeof stdin !== 'string' || onOutput !== undefined && typeof onOutput !== 'function') throw Error('Invalid execution transport options');
  if (signal !== undefined && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw Error('Invalid execution signal');
  const startedAt = Date.now();
  return new Promise(resolve => {
    let channel, done = false, dispatched = false, closed = false, exitObserved = false, stopping = false, openDelivered = false;
    let reason = 'exit', exitCode = null, exitSignal = null, captureFailed = false, transportLost = false, signalDelivery = null;
    let pendingOutput = Promise.resolve(), pendingChunks = 0, unsubscribe = () => {};
    const timers = new Set(), streams = { stdout: { chunks: [], receivedBytes: 0, retainedBytes: 0 }, stderr: { chunks: [], receivedBytes: 0, retainedBytes: 0 } };
    const later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; };
    const finish = () => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort); unsubscribe();
      pendingOutput.then(() => {
        const remoteState = !dispatched ? 'not_dispatched' : exitObserved ? 'exited' : 'unknown';
        const cleanupComplete = !dispatched || closed || transportLost;
        const metadata = state => ({ receivedBytes: state.receivedBytes, retainedBytes: state.retainedBytes,
          cursor: state.retainedBytes, truncated: state.receivedBytes > state.retainedBytes });
        const truncated = Object.values(streams).some(state => state.receivedBytes > state.retainedBytes);
        resolve({ stdout: Buffer.concat(streams.stdout.chunks).toString('utf8'), stderr: Buffer.concat(streams.stderr.chunks).toString('utf8'),
          exitCode, signal: exitSignal, durationMs: Date.now() - startedAt,
          execution: { phase: 'settled', reason, remoteState, exitCode, signal: exitSignal, automaticReplay: false, timeoutMs,
            cleanupComplete, requiresReconciliation: remoteState === 'unknown' || !cleanupComplete,
            outputState: captureFailed || truncated || remoteState === 'unknown' || !cleanupComplete || reason === 'transport_lost' ? 'partial' : 'complete',
            captureFailed, signalDelivery, stdout: metadata(streams.stdout), stderr: metadata(streams.stderr) } });
      });
    };
    const sendSignal = name => {
      if (!channel || closed) return;
      try {
        if (port.signal) port.signal(channel, name);
        else channel.signal(name);
        if (signalDelivery !== 'unsupported') signalDelivery = 'requested';
      } catch { signalDelivery = 'unsupported'; } // A sent request still is not termination evidence.
    };
    const stop = why => {
      if (done || stopping) return;
      stopping = true; reason = why;
      sendSignal('INT');
      later(() => sendSignal('TERM'), Math.max(1, Math.floor(stopGraceMs / 3)));
      later(() => sendSignal('KILL'), Math.max(1, Math.floor(stopGraceMs * 2 / 3)));
      later(() => {
        // Closing only abandons this channel; it does not prove process exit.
        if (channel && !closed) { try { channel.close(); } catch { /* unknown is retained */ } }
        finish();
      }, stopGraceMs);
    };
    const onAbort = () => stop('cancel');
    const capture = (stream, value) => {
      if (done) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), state = streams[stream];
      state.receivedBytes += bytes.length;
      const retained = bytes.subarray(0, Math.max(0, maxOutputBytes - state.retainedBytes));
      if (!retained.length) return;
      const cursor = state.retainedBytes;
      state.chunks.push(Buffer.from(retained)); state.retainedBytes += retained.length;
      const nextCursor = state.retainedBytes;
      if (!onOutput || captureFailed) return;
      // Backpressure the two channel streams while the durable sink catches up.
      channel?.pause?.(); channel?.stderr?.pause?.(); pendingChunks++;
      pendingOutput = pendingOutput.then(async () => {
        if (!captureFailed) {
          let sinkTimer;
          try {
            await Promise.race([Promise.resolve().then(() => onOutput({ stream, bytes: Buffer.from(retained), cursor, nextCursor })),
              new Promise((_, reject) => { sinkTimer = setTimeout(() => reject(Error('Output sink timeout')), stopGraceMs); })]);
          } catch { captureFailed = true; }
          finally { clearTimeout(sinkTimer); }
        }
      }).finally(() => {
        if (--pendingChunks === 0 && !done) { channel?.resume?.(); channel?.stderr?.resume?.(); }
      });
    };
    if (signal?.aborted) { reason = 'cancel'; finish(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    unsubscribe = port.onTransportLost?.(() => {
      if (done) return;
      transportLost = true;
      if (!stopping) reason = 'transport_lost';
      finish();
    }) ?? (() => {});
    if (done) { unsubscribe(); return; }
    later(() => stop('deadline'), timeoutMs);
    if (done || stopping) return;
    try {
      // No automatic retry: an exception after this call may follow dispatch.
      dispatched = true;
      port.open(command, (error, opened) => {
        if (openDelivered) {
          if (opened && opened !== channel) { opened.on?.('error', () => {}); try { opened.close(); } catch { /* duplicate callback owns no new execution */ } }
          return;
        }
        openDelivered = true;
        if (error) {
          if (done) return;
          // A CHANNEL_FAILURE is a confirmed refusal. Other errors may race exec.
          if (error.reason !== undefined) dispatched = false;
          reason = stopping ? reason : 'channel_open_failed'; finish(); return;
        }
        channel = opened;
        if (done) {
          channel.on('error', () => {});
          sendSignal('KILL');
          try { channel.close(); } catch { /* late unknown channel */ }
          return;
        }
        channel.on('data', value => capture('stdout', value));
        channel.stderr?.on('data', value => capture('stderr', value));
        channel.on('exit', (code, signalName) => {
          exitObserved = true; exitCode = Number.isInteger(code) ? code : null; exitSignal = signalName || null;
          later(() => {
            if (done || closed) return;
            try { channel.close(); } catch { /* exit evidence does not prove channel cleanup */ }
            finish();
          }, stopGraceMs);
        });
        channel.on('error', () => stop('transport_lost'));
        channel.on('close', (code, signalName) => {
          closed = true;
          if (Number.isInteger(code) || signalName) { exitObserved = true; exitCode = Number.isInteger(code) ? code : exitCode; exitSignal = signalName || exitSignal; }
          if (!exitObserved && !stopping) reason = 'transport_lost';
          finish();
        });
        if (stopping) { sendSignal('INT'); return; }
        try { if (stdin !== undefined) channel.write(stdin); channel.end(); }
        catch { stop('input_failed'); }
      });
    } catch { reason = 'channel_open_failed'; finish(); }
  });
}

/** Remove only presentation noise; callers retain the original stderr separately.
 * CLIXML is never deserialized, and non-progress records are kept verbatim. */
export function presentStderr(stderr) {
  if (!stderr.includes('#< CLIXML')) return stderr;
  return stderr.replace(/#< CLIXML\r?\n(<Objs\b[^>]*>[\s\S]*?<\/Objs>)/g, (raw, xml) => {
    const withoutProgress = xml.replace(/<Obj\b(?=[^>]*\bS=["']progress["'])[^>]*>[\s\S]*?<\/Obj>/g, '')
      .replace(/<S\b(?=[^>]*\bS=["']progress["'])[^>]*>[\s\S]*?<\/S>/g, '');
    return /^<Objs\b[^>]*>\s*<\/Objs>$/.test(withoutProgress) ? '' : '#< CLIXML\n' + withoutProgress;
  });
}
