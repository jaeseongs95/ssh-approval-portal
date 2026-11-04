#!/usr/bin/env python3
"""관리형 X11 GUI 한 개. stdin/stdout은 RFB, stderr는 제한된 JSON 영수증.

설치·서비스·기존 display를 바꾸지 않는다. Xvnc inetd fd에는 socketpair를
주고 SSH의 분리된 pipe와 제한된 버퍼로 중계한다.
"""
import argparse
import hashlib
import json
import os
import secrets
import selectors
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time


class SessionError(Exception):
    pass


def report(event, **fields):
    print(json.dumps({"agsDesktop": 1, "event": event, **fields}, separators=(",", ":")),
          file=sys.stderr, flush=True)


def authority(path, display, cookie):
    # FamilyWild는 주소만 무시하므로 display 번호도 실제 할당값으로 기록한다.
    fields = (b"", str(display).encode("ascii"), b"MIT-MAGIC-COOKIE-1", cookie)
    with open(path, "wb") as output:
        output.write(struct.pack("!H", 65535))
        for field in fields:
            output.write(struct.pack("!H", len(field)) + field)


def stop(children):
    """직접 생성한 프로세스 그룹만 종료하고 자식 종료를 회수한다."""
    for child in reversed(children):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 1
    for child in reversed(children):
        try:
            child.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=1)


def relay(peer, children, deadline):
    """양방향 버퍼 각각 64KiB. EOF·자식 종료·절대 TTL에서 끝낸다."""
    pending_in, pending_out = bytearray(), bytearray()
    peer.setblocking(False)
    os.set_blocking(0, False)
    os.set_blocking(1, False)
    with selectors.DefaultSelector() as selector:
        while time.monotonic() < deadline:
            if any(child.poll() is not None for child in children):
                return "process_exit"
            wanted = {}
            if len(pending_in) < 65536:
                wanted[0] = selectors.EVENT_READ
            if pending_out:
                wanted[1] = selectors.EVENT_WRITE
            mask = selectors.EVENT_READ if len(pending_out) < 65536 else 0
            if pending_in:
                mask |= selectors.EVENT_WRITE
            if mask:
                wanted[peer.fileno()] = mask
            for key in list(selector.get_map().values()):
                if key.fd not in wanted:
                    selector.unregister(key.fd)
            for fd, events in wanted.items():
                if fd in selector.get_map():
                    selector.modify(fd, events)
                else:
                    selector.register(fd, events)
            for key, events in selector.select(min(0.2, max(0, deadline - time.monotonic()))):
                try:
                    if key.fd == 0:
                        data = os.read(0, 65536 - len(pending_in))
                        if not data:
                            return "input_eof"
                        pending_in.extend(data)
                    elif key.fd == 1:
                        written = os.write(1, pending_out)
                        del pending_out[:written]
                    else:
                        if events & selectors.EVENT_READ:
                            data = peer.recv(65536 - len(pending_out))
                            if not data:
                                return "backend_eof"
                            pending_out.extend(data)
                        if events & selectors.EVENT_WRITE:
                            written = peer.send(pending_in)
                            del pending_in[:written]
                except BlockingIOError:
                    pass
                except (BrokenPipeError, ConnectionResetError):
                    return "transport_closed"
    return "ttl"


def run(options):
    executables = {name: shutil.which(name, path="/usr/bin:/bin")
                   for name in ("Xvnc", "openbox", "xterm", "xdpyinfo")}
    if not all(executables.values()):
        raise SessionError("DESKTOP_BACKEND_UNAVAILABLE")
    children = []
    peer = backend = None
    display_read = display_write = None
    closed = False
    with tempfile.TemporaryDirectory(prefix="ags-gui-") as root:
        os.chmod(root, 0o700)
        auth = os.path.join(root, "Xauthority")
        cookie = secrets.token_bytes(16)
        authority(auth, 0, cookie)
        os.chmod(auth, 0o600)
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": root,
                       "XAUTHORITY": auth, "XDG_RUNTIME_DIR": root,
                       "XDG_CONFIG_HOME": root, "XDG_CACHE_HOME": root}
        peer, backend = socket.socketpair()
        display_read, display_write = os.pipe()
        deadline = time.monotonic() + options.ttl_ms / 1000
        try:
            xvnc = subprocess.Popen([
                executables["Xvnc"], "-inetd", "-displayfd", str(display_write),
                "-nolisten", "tcp", "-auth", auth, "-geometry",
                f"{options.width}x{options.height}", "-depth", "24",
                "-SecurityTypes", "None", "-AcceptCutText=0", "-SendCutText=0",
                "-SendPrimary=0", "-SetPrimary=0", "-AllowOverride=",
                "-MaxConnectionTime", str((options.ttl_ms + 999) // 1000),
                "-MaxDisconnectionTime", "10", "-desktop", "AGS agent desktop"],
                stdin=backend, stdout=backend, stderr=subprocess.DEVNULL,
                pass_fds=(display_write,), env=environment, start_new_session=True)
            children.append(xvnc)
            backend.close()
            backend = None
            os.close(display_write)
            display_write = None
            with selectors.DefaultSelector() as selector:
                selector.register(display_read, selectors.EVENT_READ)
                if not selector.select(min(10, options.ttl_ms / 1000)):
                    raise SessionError("DESKTOP_START_TIMEOUT")
                allocated = os.read(display_read, 32).strip()
            if not allocated.isdigit() or xvnc.poll() is not None:
                raise SessionError("DESKTOP_XVNC_START_FAILED")
            display = int(allocated)
            authority(auth, display, cookie)
            environment["DISPLAY"] = ":" + str(display)
            result = subprocess.run([executables["xdpyinfo"]], env=environment,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=3, check=False)
            if result.returncode != 0:
                raise SessionError("DESKTOP_DISPLAY_UNAVAILABLE")
            for executable, args in (("openbox", []), ("xterm", ["-title", "AGS agent terminal",
                                      "-geometry", "100x30+10+10", "-e", "/bin/sh"])):
                child = subprocess.Popen([executables[executable], *args], env=environment,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True)
                children.append(child)
            # 즉시 실패한 창 관리자·앱은 ready로 보고하지 않는다.
            time.sleep(0.15)
            if any(child.poll() is not None for child in children):
                raise SessionError("DESKTOP_APPLICATION_START_FAILED")
            generation = hashlib.sha256((options.session_ref + ":" + secrets.token_hex(32)).encode()).hexdigest()
            report("ready", sessionRef=options.session_ref, resourceGeneration=generation,
                   display=display, width=options.width, height=options.height,
                   pids=[child.pid for child in children])
            reason = relay(peer, children, deadline)
            stop(children)
            children.clear()
            closed = True
            report("closed", sessionRef=options.session_ref, sessionState="terminated", reason=reason)
        finally:
            try:
                stop(children)
            finally:
                if peer is not None:
                    peer.close()
                if backend is not None:
                    backend.close()
                for fd in (display_read, display_write):
                    if fd is not None:
                        os.close(fd)
                if not closed:
                    report("closed", sessionRef=options.session_ref, sessionState="terminated", reason="startup_failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--ttl-ms", type=int, default=900000)
    parser.add_argument("--session-ref", required=True)
    options = parser.parse_args()
    if (not 64 <= options.width <= 4096 or not 64 <= options.height <= 4096
            or options.width * options.height > 4194304 or not 1000 <= options.ttl_ms <= 900000
            or len(options.session_ref) != 48 or any(c not in "0123456789abcdef" for c in options.session_ref)):
        parser.error("invalid session options")
    os.umask(0o077)
    def cancelled(signum, frame):
        raise SessionError("DESKTOP_CANCELLED")
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    signal.signal(signal.SIGHUP, cancelled)
    try:
        run(options)
        return 0
    except SessionError as error:
        report("error", code=str(error))
        return 1
    except (OSError, subprocess.SubprocessError):
        report("error", code="DESKTOP_SESSION_FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(main())
