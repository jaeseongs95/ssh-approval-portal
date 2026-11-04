#!/usr/bin/env python3
"""관리형 X11 GUI 한 개. stdin/stdout은 RFB, stderr는 제한된 JSON 영수증.

설치·서비스·기존 display를 바꾸지 않는다. Xvnc inetd fd에는 socketpair를
주고 SSH의 분리된 pipe와 제한된 버퍼로 중계한다.
"""
import argparse
import ctypes
import hashlib
import json
import os
import re
import secrets
import selectors
import shutil
import signal
import socket
import stat
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


def read_bootstrap():
    """RFB 앞의 한 줄만 읽는다. 비밀은 argv·환경·영수증에 넣지 않는다."""
    data = bytearray()
    deadline = time.monotonic() + 10
    with selectors.DefaultSelector() as selector:
        selector.register(0, selectors.EVENT_READ)
        while len(data) <= 8192:
            if not selector.select(max(0, deadline - time.monotonic())):
                raise SessionError("DESKTOP_CREDENTIAL_INPUT_REQUIRED")
            value = os.read(0, 1)
            if not value:
                raise SessionError("DESKTOP_CREDENTIAL_INPUT_REQUIRED")
            if value == b"\n":
                break
            data.extend(value)
        else:
            raise SessionError("DESKTOP_INVALID_BOOTSTRAP")
    try:
        result = json.loads(data.decode("utf8"))
        if not isinstance(result, dict) or set(result) != {"username", "domain", "password"}:
            raise ValueError()
        for key, value in result.items():
            if (not isinstance(value, str) or len(value.encode("utf8")) > 510
                    or key != "domain" and not value or any(ord(c) < 32 or ord(c) == 127 for c in value)):
                raise ValueError()
        return result
    except (ValueError, UnicodeError):
        raise SessionError("DESKTOP_INVALID_BOOTSTRAP") from None
    finally:
        data.clear()


def validate_native_rdp(options):
    """부모 manifest에 고정된 private 파일과 전용 socket을 비밀 입력 전에 확인한다."""
    path = options.rdp_executable
    if (not os.path.isabs(path) or os.path.normpath(path) != path
            or not path.endswith("/native/freerdp-input/runtime/bin/xfreerdp3")
            or not re.fullmatch(r"[a-f0-9]{64}", options.rdp_executable_sha256 or "")
            or not re.fullmatch(r"[a-f0-9]{64}", options.rdp_patch_digest or "")):
        raise SessionError("DESKTOP_RDP_CLIENT_UNAVAILABLE")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111:
                raise SessionError("DESKTOP_RDP_CLIENT_UNAVAILABLE")
            digest = hashlib.file_digest(source, "sha256").hexdigest()
    except OSError:
        raise SessionError("DESKTOP_RDP_CLIENT_UNAVAILABLE") from None
    if digest != options.rdp_executable_sha256:
        raise SessionError("DESKTOP_RDP_CLIENT_UNAVAILABLE")
    try:
        control = socket.socket(fileno=3)
        try:
            if control.family != socket.AF_UNIX or control.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM:
                raise SessionError("DESKTOP_NATIVE_INVALID_CHANNEL")
            control.getpeername()
            os.set_inheritable(3, False)
        finally:
            control.detach()
    except OSError:
        raise SessionError("DESKTOP_NATIVE_INVALID_CHANNEL") from None
    return path


def focus_window(display, window, cookie):
    """이 helper의 전용 display에서 매핑을 확인한 앱에만 초기 focus를 준다."""
    xlib = ctypes.CDLL("libX11.so.6")
    pointer, integer, window_type = ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong
    xlib.XSetAuthorization.argtypes = [ctypes.c_char_p, integer, ctypes.c_char_p, integer]
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XOpenDisplay.restype = pointer
    xlib.XCloseDisplay.argtypes = [pointer]
    xlib.XSetInputFocus.argtypes = [pointer, window_type, integer, window_type]
    xlib.XGetInputFocus.argtypes = [pointer, ctypes.POINTER(window_type), ctypes.POINTER(integer)]
    xlib.XSync.argtypes = [pointer, integer]
    errors = []
    callback_type = ctypes.CFUNCTYPE(integer, pointer, pointer)
    callback = callback_type(lambda connection, event: errors.append(True) or 0)
    xlib.XSetErrorHandler.argtypes = [callback_type]
    xlib.XSetErrorHandler(callback)
    xlib.XSetAuthorization(b"MIT-MAGIC-COOKIE-1", 18, cookie, len(cookie))
    connection = xlib.XOpenDisplay(display.encode("ascii"))
    if not connection:
        raise SessionError("DESKTOP_DISPLAY_UNAVAILABLE")
    try:
        xlib.XSetInputFocus(connection, window, 2, 0)
        xlib.XSync(connection, 0)
        focused, revert = window_type(), integer()
        xlib.XGetInputFocus(connection, ctypes.byref(focused), ctypes.byref(revert))
        if errors or focused.value != window:
            raise SessionError("DESKTOP_INPUT_FOCUS_UNVERIFIED")
    finally:
        xlib.XCloseDisplay(connection)


def stop(children):
    """직접 만든 그룹과 subreaper가 인수한 자식만 종료·회수한다."""
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
    # 터미널에서 setsid로 분리한 앱도 이 helper의 고아 자식으로 돌아온다.
    # pidfd를 연 뒤 현재 PPid까지 확인하여 재사용된 타 프로세스 PID는 건드리지 않는다.
    deadline = time.monotonic() + 2
    while True:
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
            except ChildProcessError:
                break
        with open(f"/proc/self/task/{os.getpid()}/children", "r") as source:
            owned = [int(value) for value in source.read().split()]
        if not owned:
            return
        if len(owned) > 256 or time.monotonic() >= deadline:
            raise SessionError("DESKTOP_CLEANUP_FAILED")
        for pid in owned:
            try:
                fd = os.pidfd_open(pid)
                try:
                    with open(f"/proc/{pid}/stat", "r") as source:
                        parent = int(source.read().rsplit(") ", 1)[1].split()[1])
                    if parent == os.getpid():
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                finally:
                    os.close(fd)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
        time.sleep(0.01)


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
    app_name = "xterm" if options.application == "terminal" else "rdp-native"
    native_executable = validate_native_rdp(options) if options.application == "rdp" else None
    executables = {name: shutil.which(name, path="/usr/bin:/bin")
                   for name in ("Xvnc", "openbox", "xdpyinfo", "xwininfo", "xprop")}
    executables[app_name] = native_executable or shutil.which(app_name, path="/usr/bin:/bin")
    if not all(executables.values()):
        raise SessionError("DESKTOP_BACKEND_UNAVAILABLE")
    credentials = read_bootstrap() if options.application == "rdp" else None
    children = []
    peer = backend = None
    display_read = display_write = None
    native_fd = 3 if native_executable else None
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
                "-nolisten", "tcp", "-noreset", "-auth", auth, "-geometry",
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
            app_args = (["-title", "AGS agent terminal", "-geometry", "100x30+10+10", "-e", "/bin/sh"]
                        if options.application == "terminal" else [
                            f"/v:127.0.0.1:{options.rdp_port}", "/from-stdin", "/sec:nla", "/cert:ignore",
                            f"/size:{options.width}x{options.height}", "/f", "/title:AGS agent RDP", "-clipboard", "/log-level:OFF",
                            "/kbd:unicode:on", "/ags-input-fd:3"])
            for executable, args in (("openbox", []), (app_name, app_args)):
                child = subprocess.Popen([executables[executable], *args], env=environment,
                                         stdin=subprocess.PIPE if executable == app_name and credentials is not None else subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True,
                                         pass_fds=(native_fd,) if executable == app_name and native_fd is not None else ())
                children.append(child)
                if executable == app_name and native_fd is not None:
                    os.close(native_fd)
                    native_fd = None
                if executable == "openbox":
                    # WM가 SubstructureRedirect를 확보하고 EWMH 초기화를 끝낸 뒤 앱을 만든다.
                    wm_deadline = min(deadline, time.monotonic() + 5)
                    while True:
                        if child.poll() is not None:
                            raise SessionError("DESKTOP_WINDOW_MANAGER_FAILED")
                        state = subprocess.run([executables["xprop"], "-root", "_NET_SUPPORTING_WM_CHECK"],
                                               env=environment, capture_output=True, timeout=1, check=False)
                        if re.search(rb"window id # 0x[1-9a-fA-F][0-9a-fA-F]*", state.stdout):
                            break
                        if time.monotonic() >= wm_deadline:
                            raise SessionError("DESKTOP_WINDOW_MANAGER_NOT_READY")
                        time.sleep(0.02)
                if executable == app_name and credentials is not None:
                    try:
                        child.stdin.write((credentials["username"] + "\n" + credentials["domain"] + "\n"
                                           + credentials["password"] + "\n").encode("utf8"))
                        child.stdin.close()
                    finally:
                        credentials.clear()
            # EWMH 활성창 속성이 없는 서버도 있다. 실제 매핑과 X11 입력 focus를 확인한다.
            ready_deadline = min(deadline, time.monotonic() + 10)
            title = "AGS agent terminal" if options.application == "terminal" else "AGS agent RDP"
            while True:
                if any(child.poll() is not None for child in children):
                    raise SessionError("DESKTOP_APPLICATION_START_FAILED")
                window = subprocess.run([executables["xwininfo"], "-name", title, "-stats"],
                                        env=environment, capture_output=True, timeout=1, check=False)
                match = re.search(rb"Window id: (0x[0-9a-fA-F]+)", window.stdout)
                if match and b"Map State: IsViewable" in window.stdout:
                    focus_window(environment["DISPLAY"], int(match[1], 16), cookie)
                    break
                if time.monotonic() >= ready_deadline:
                    raise SessionError("DESKTOP_WINDOW_NOT_READY")
                time.sleep(0.02)
            generation = hashlib.sha256((options.session_ref + ":" + secrets.token_hex(32)).encode()).hexdigest()
            report("ready", sessionRef=options.session_ref, resourceGeneration=generation,
                   display=display, width=options.width, height=options.height,
                   pids=[child.pid for child in children])
            reason = relay(peer, children, deadline)
            stop(children)
            children.clear()
            closed = True
            report("closed", sessionRef=options.session_ref, sessionState="terminated", reason=reason,
                   cleanupScope="owned-descendants")
        finally:
            try:
                stop(children)
            finally:
                if peer is not None:
                    peer.close()
                if backend is not None:
                    backend.close()
                for fd in (display_read, display_write, native_fd):
                    if fd is not None:
                        os.close(fd)
                if not closed:
                    report("closed", sessionRef=options.session_ref, sessionState="terminated", reason="startup_failed",
                           cleanupScope="owned-descendants")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--ttl-ms", type=int, default=900000)
    parser.add_argument("--session-ref", required=True)
    parser.add_argument("--application", choices=("terminal", "rdp"), default="terminal")
    parser.add_argument("--rdp-port", type=int)
    parser.add_argument("--rdp-executable")
    parser.add_argument("--rdp-executable-sha256")
    parser.add_argument("--rdp-patch-digest")
    parser.add_argument("--rdp-certificate-mode", choices=("ssh-tunnel",))
    options = parser.parse_args()
    if (not 64 <= options.width <= 4096 or not 64 <= options.height <= 4096
            or options.width * options.height > 4194304 or not 1000 <= options.ttl_ms <= 900000
            or len(options.session_ref) != 48 or any(c not in "0123456789abcdef" for c in options.session_ref)):
        parser.error("invalid session options")
    if (options.application == "rdp" and (options.rdp_port is None or not 1 <= options.rdp_port <= 65535
            or options.rdp_executable is None or options.rdp_executable_sha256 is None
            or options.rdp_patch_digest is None or options.rdp_certificate_mode != "ssh-tunnel")
            or options.application == "terminal" and any(value is not None for value in (
                options.rdp_port, options.rdp_executable, options.rdp_executable_sha256,
                options.rdp_patch_digest, options.rdp_certificate_mode))):
        parser.error("invalid application options")
    os.umask(0o077)
    def cancelled(signum, frame):
        raise SessionError("DESKTOP_CANCELLED")
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    signal.signal(signal.SIGHUP, cancelled)
    try:
        # 프로세스 단위 설정이다. 다른 세션·서비스·사용자 정책을 바꾸지 않는다.
        if (not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal")
                or ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0):
            raise SessionError("DESKTOP_PROCESS_SUPERVISION_UNAVAILABLE")
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
