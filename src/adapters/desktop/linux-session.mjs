import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRfbDesktopAdapter } from './rfb.mjs';
import { desktopFail } from '../../domain/desktop-lease.mjs';

const helper = readFileSync(new URL('../../../scripts/linux-desktop-session.py', import.meta.url), 'utf8');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const wait = (promise, timeoutMs, code) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(Error(code), { code })), timeoutMs);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** 고정 제품 helper만 실행한다. 모델 요청으로 source/command/실행 파일을 받지 않는다. */
export function createLinuxSessionDesktopAdapter({ openSession, width = 1280, height = 720, ttlMs = 900000 } = {}) {
  if (typeof openSession !== 'function' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 64 || height < 64 || width > 4096 || height > 4096 || width * height > 4194304
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 900000 || Buffer.byteLength(helper) > 24576) desktopFail('DESKTOP_INVALID_CONFIG');
  return {
    async open({ binding, signal }) {
      const sessionRef = randomBytes(24).toString('hex');
      const command = `/usr/bin/python3 -I -B -S -X utf8 -c ${quote(helper)} --session-ref ${sessionRef} --width ${width} --height ${height} --ttl-ms ${ttlMs}`;
      if (Buffer.byteLength(command) > 32768) desktopFail('DESKTOP_INVALID_CONFIG');
      const channel = await openSession({ binding, signal, command });
      const stderrStream = channel.stderr ?? channel.stream.stderr;
      let ready, closedReceipt, exited = false, stderr = '', closing, desktop;
      let resolveReady, rejectReady;
      const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      readyPromise.catch(() => {});
      const exitPromise = Promise.resolve(channel.exitPromise).then(result => {
        exited = true;
        if (!ready) rejectReady(Object.assign(Error('DESKTOP_BACKEND_UNAVAILABLE'), { code: 'DESKTOP_BACKEND_UNAVAILABLE' }));
        return result;
      });
      const onStderr = bytes => {
        stderr += bytes.toString('utf8');
        if (Buffer.byteLength(stderr) > 16384) {
          rejectReady(Object.assign(Error('DESKTOP_WIRE_LIMIT'), { code: 'DESKTOP_WIRE_LIMIT' }));
          void channel.close(); return;
        }
        while (stderr.includes('\n')) {
          const end = stderr.indexOf('\n'), line = stderr.slice(0, end); stderr = stderr.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.agsDesktop !== 1) continue;
          if (event.event === 'error' && /^DESKTOP_[A-Z_]+$/.test(event.code)) {
            rejectReady(Object.assign(Error(event.code), { code: event.code }));
          } else if (event.event === 'ready' && event.sessionRef === sessionRef
            && /^[a-f0-9]{64}$/.test(event.resourceGeneration) && event.width === width && event.height === height) {
            ready = event; resolveReady(event);
          } else if (event.event === 'closed' && event.sessionRef === sessionRef && event.sessionState === 'terminated') closedReceipt = event;
        }
      };
      stderrStream?.on('data', onStderr);
      const closeChannel = () => closing ??= (async () => {
        try {
          channel.stream.end(); // EOF를 보내 helper가 소유 프로세스 정리를 마치도록 한다.
          const result = await wait(exitPromise, 5000, 'DESKTOP_CLOSE_TIMEOUT');
          return { sessionState: closedReceipt && result?.exitCode === 0 && result?.remoteState === 'exited' ? 'terminated' : 'unknown' };
        } catch {
          return { sessionState: 'unknown' };
        } finally {
          await channel.close();
          stderrStream?.removeListener('data', onStderr);
        }
      })();
      try {
        desktop = await createRfbDesktopAdapter({ allowNoneSecurity: true,
          openChannel: async () => ({ stream: channel.stream, close: closeChannel }) }).open({ binding, signal });
        await wait(readyPromise, 10000, 'DESKTOP_START_TIMEOUT');
        if (exited) desktopFail('DESKTOP_TRANSPORT_CLOSED');
        return {
          get closed() { return exited || desktop.closed; },
          lifecycle: 'managed', capabilities: { observe: true, pointer: true, key: true, text: true },
          observe: options => desktop.observe(options), input: actions => desktop.input(actions), release: () => desktop.release(),
          readState: () => ({ state: exited ? 'capture_unavailable' : 'desktop_ready', observedAt: Date.now(),
            generation: ready.resourceGeneration, resourceGeneration: ready.resourceGeneration, sessionRef,
            osSessionId: null, locked: null, sessionBindingVerified: true, displayBindingVerified: true,
            inputVerified: true, inputAllowed: !exited, ownerOnly: false, blockers: exited ? ['DESKTOP_CAPTURE_UNAVAILABLE'] : [] }),
          async close() { await desktop.close(); return closeChannel(); },
        };
      } catch (error) {
        try { await closeChannel(); } catch { /* 원 open 오류는 보존한다. */ }
        throw error;
      }
    },
  };
}
