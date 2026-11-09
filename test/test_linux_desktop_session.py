"""Private executable/fd parser boundary. Run on the Linux TEST host only."""
import contextlib
import hashlib
import importlib.util
import os
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "linux_desktop_session", Path(__file__).resolve().parents[1] / "scripts/linux-desktop-session.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


@contextlib.contextmanager
def descriptor_three(source):
    """Keep the runner's fd intact; expose only this test's endpoint as inherited fd3."""
    try:
        original = os.dup(3)
    except OSError:
        original = None
    inherited = os.get_inheritable(3) if original is not None else False
    duplicate = os.dup(source)
    try:
        os.dup2(duplicate, 3, inheritable=True)
        yield
    finally:
        if original is None:
            try:
                os.close(3)
            except OSError:
                pass
        else:
            os.dup2(original, 3, inheritable=inherited)
            os.close(original)
        os.close(duplicate)


class NativeRdpValidationTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="ags-native-helper-test-")
        self.addCleanup(self.folder.cleanup)
        self.executable = Path(self.folder.name) / "native/freerdp-input/runtime/bin/xfreerdp3"
        self.executable.parent.mkdir(parents=True)
        self.executable.write_bytes(b"fixed-private-native-artifact\n")
        self.executable.chmod(0o700)
        self.options = SimpleNamespace(application="rdp", rdp_executable=str(self.executable),
            rdp_executable_sha256=hashlib.sha256(self.executable.read_bytes()).hexdigest(),
            rdp_patch_digest="c" * 64)

    def test_exact_private_hash_and_unix_stream_keep_fd_open_but_not_inheritable(self):
        local, peer = socket.socketpair()
        self.addCleanup(local.close)
        self.addCleanup(peer.close)
        with descriptor_three(local.fileno()):
            self.assertEqual(helper.validate_native_rdp(self.options), str(self.executable))
            self.assertFalse(os.get_inheritable(3))
            peer.sendall(b"x")
            self.assertEqual(os.read(3, 1), b"x")

    def test_bad_manifest_or_stock_path_fails_before_bootstrap(self):
        for changes in ({"rdp_executable_sha256": "0" * 64}, {"rdp_patch_digest": "bad"},
                        {"rdp_executable": "/usr/bin/xfreerdp3"},
                        {"rdp_executable": str(self.executable.parent / "../bin/xfreerdp3")}):
            with self.subTest(changes=changes):
                options = SimpleNamespace(**(vars(self.options) | changes))
                with patch.object(helper, "read_bootstrap") as bootstrap:
                    with self.assertRaisesRegex(helper.SessionError, "^DESKTOP_RDP_CLIENT_UNAVAILABLE$"):
                        helper.run(options)
                    bootstrap.assert_not_called()

    def test_changed_executable_missing_file_symlink_and_nonexecutable_are_rejected(self):
        self.executable.write_bytes(b"changed")
        with self.assertRaisesRegex(helper.SessionError, "DESKTOP_RDP_CLIENT_UNAVAILABLE"):
            helper.validate_native_rdp(self.options)
        self.executable.unlink()
        with self.assertRaisesRegex(helper.SessionError, "DESKTOP_RDP_CLIENT_UNAVAILABLE"):
            helper.validate_native_rdp(self.options)
        replacement = self.executable.parent / "replacement"
        replacement.write_bytes(b"fixed-private-native-artifact\n")
        replacement.chmod(0o700)
        self.executable.symlink_to(replacement)
        with self.assertRaisesRegex(helper.SessionError, "DESKTOP_RDP_CLIENT_UNAVAILABLE"):
            helper.validate_native_rdp(self.options)
        self.executable.unlink()
        self.executable.write_bytes(replacement.read_bytes())
        self.executable.chmod(0o600)
        with self.assertRaisesRegex(helper.SessionError, "DESKTOP_RDP_CLIENT_UNAVAILABLE"):
            helper.validate_native_rdp(self.options)

    def test_pipe_datagram_unconnected_or_missing_fd_fails_before_bootstrap(self):
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, read_fd)
        self.addCleanup(os.close, write_fd)
        datagram = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        unconnected = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(datagram.close)
        self.addCleanup(unconnected.close)
        for source in (read_fd, datagram.fileno(), unconnected.fileno()):
            with self.subTest(source=source), descriptor_three(source):
                with patch.object(helper, "read_bootstrap") as bootstrap:
                    with self.assertRaisesRegex(helper.SessionError, "^DESKTOP_NATIVE_INVALID_CHANNEL$"):
                        helper.run(self.options)
                    bootstrap.assert_not_called()
        with descriptor_three(read_fd):
            os.close(3)
            with patch.object(helper, "read_bootstrap") as bootstrap:
                with self.assertRaisesRegex(helper.SessionError, "^DESKTOP_NATIVE_INVALID_CHANNEL$"):
                    helper.run(self.options)
                bootstrap.assert_not_called()

    def test_only_native_child_inherits_control_and_parent_closes_before_credentials(self):
        local, peer = socket.socketpair()
        self.addCleanup(local.close)
        self.addCleanup(peer.close)
        options = SimpleNamespace(**(vars(self.options) | dict(ttl_ms=30000, width=800, height=600,
            session_ref="a" * 48, rdp_port=3389, rdp_certificate_mode="ssh-tunnel")))
        launches, credential_writes = [], []

        class CredentialStdin:
            def write(inner, data):
                with self.assertRaises(OSError):
                    os.fstat(3)
                credential_writes.append(bytes(data))

            def close(inner):
                pass

        def popen(args, **kwargs):
            launches.append((args, kwargs))
            if args[0] == "/usr/bin/Xvnc":
                self.assertNotIn(3, kwargs["pass_fds"])
                os.write(kwargs["pass_fds"][0], b"44\n")
            elif args[0] == str(self.executable):
                self.assertEqual(kwargs["pass_fds"], (3,))
                self.assertIn("/ags-input-fd:3", args)
                # FreeRDP bf217a5 cmdline.c:5522 disables Unicode unless requested.
                self.assertEqual([arg for arg in args if arg.startswith("/kbd:")], ["/kbd:unicode:on"])
                self.assertIn("-clipboard", args)
                os.fstat(3)
            else:
                self.assertEqual(kwargs.get("pass_fds", ()), ())
            return SimpleNamespace(pid=100 + len(launches), poll=lambda: None, stdin=CredentialStdin())

        def command(args, **kwargs):
            if args[0] == "/usr/bin/xprop":
                output = b"window id # 0x123"
            else:
                output = b"Window id: 0x123\nMap State: IsViewable"
            return SimpleNamespace(returncode=0, stdout=output)

        with descriptor_three(local.fileno()), patch.object(helper.shutil, "which", side_effect=lambda name, **_: "/usr/bin/" + name), \
                patch.object(helper.os, "access", return_value=True), \
                patch.object(helper, "read_bootstrap", return_value=dict(username="test-user", domain="", password="test-only")), \
                patch.object(helper.subprocess, "Popen", side_effect=popen), \
                patch.object(helper.subprocess, "run", side_effect=command), \
                patch.object(helper, "focus_window"), patch.object(helper, "stop"), \
                patch.object(helper, "relay", return_value="test_complete"), patch.object(helper, "report"):
            helper.run(options)
        self.assertEqual(len(launches), 3)
        self.assertEqual(launches[-1][0][0], str(self.executable))
        self.assertEqual(credential_writes, [b"test-user\n\ntest-only\n"])


class StartupDeadlineTest(unittest.TestCase):
    """운영 clock/기한은 바꾸지 않고 기존 run 경계에서 경과 시간만 제어한다."""

    def scenario(self, mode, ttl_ms, expected):
        clock, launches = [100.0], []
        options = SimpleNamespace(application="terminal", ttl_ms=ttl_ms, width=800, height=600,
                                  session_ref="a" * 48)

        def popen(args, **kwargs):
            if args[0] == "/usr/bin/Xvnc" and not mode.startswith("display_"):
                os.write(kwargs["pass_fds"][0], b"44\n")
            child = SimpleNamespace(pid=100 + len(launches), poll=lambda: None)
            launches.append(child)
            return child

        def command(args, **kwargs):
            name = Path(args[0]).name
            if name == "xprop":
                if mode == "wm_phase":
                    clock[0] += 0.4
                    output = b""
                else:
                    output = b"window id # 0x123"
            elif name == "xwininfo":
                if mode in ("global_window", "late_viewable", "global_probe_timeout"):
                    clock[0] += ttl_ms / 1000 + 0.1
                if mode == "global_probe_timeout":
                    raise helper.subprocess.TimeoutExpired(args, kwargs["timeout"])
                if mode == "window_phase":
                    clock[0] += 0.4
                output = (b"" if mode in ("global_window", "window_phase") else
                          b"Window id: 0x123\nMap State: IsViewable")
            else:
                output = b""
            return SimpleNamespace(returncode=0, stdout=output)

        def focus(*_):
            if mode == "late_focus":
                clock[0] += ttl_ms / 1000 + 0.1

        class EmptyDisplaySelector:
            def __enter__(inner):
                return inner

            def __exit__(inner, *_):
                pass

            def register(inner, *_):
                pass

            def select(inner, timeout):
                clock[0] += (ttl_ms / 1000 if mode == "display_global" else 10) + 0.01
                return []

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(helper.shutil, "which", side_effect=lambda name, **_: "/usr/bin/" + name))
            stack.enter_context(patch.object(helper.os, "access", return_value=True))
            stack.enter_context(patch.object(helper.subprocess, "Popen", side_effect=popen))
            stack.enter_context(patch.object(helper.subprocess, "run", side_effect=command))
            stack.enter_context(patch.object(helper.time, "monotonic", side_effect=lambda: clock[0]))
            stack.enter_context(patch.object(helper.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)))
            stack.enter_context(patch.object(helper, "focus_window", side_effect=focus))
            stack.enter_context(patch.object(helper, "relay", return_value="test_complete"))
            stopped = stack.enter_context(patch.object(helper, "stop"))
            reported = stack.enter_context(patch.object(helper, "report"))
            if mode.startswith("display_"):
                stack.enter_context(patch.object(helper.selectors, "DefaultSelector", EmptyDisplaySelector))
            with self.assertRaisesRegex(helper.SessionError, "^" + expected + "$"):
                helper.run(options)
        self.assertFalse(any(call.args[0] == "ready" for call in reported.call_args_list))
        closed = [call.kwargs for call in reported.call_args_list if call.args[0] == "closed"]
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0]["reason"], "startup_failed")
        self.assertEqual(closed[0]["sessionState"], "terminated")
        self.assertEqual(closed[0]["cleanupScope"], "owned-descendants")
        if expected == "DESKTOP_EXPIRED" or "pids" in closed[0]:
            self.assertEqual(closed[0]["pids"], [child.pid for child in launches])
        stopped.assert_called_once_with(launches)

    def test_global_expiry_during_failed_window_probe_is_not_window_timeout(self):
        self.scenario("global_window", 1500, "DESKTOP_EXPIRED")

    def test_late_viewable_or_focus_never_emits_ready(self):
        for mode in ("late_viewable", "late_focus"):
            with self.subTest(mode=mode):
                self.scenario(mode, 1500, "DESKTOP_EXPIRED")

    def test_global_probe_timeout_or_display_wait_is_expired(self):
        for mode in ("global_probe_timeout", "display_global"):
            with self.subTest(mode=mode):
                self.scenario(mode, 1500, "DESKTOP_EXPIRED")

    def test_phase_deadlines_keep_their_original_error_codes(self):
        for mode, expected in (("window_phase", "DESKTOP_WINDOW_NOT_READY"),
                               ("wm_phase", "DESKTOP_WINDOW_MANAGER_NOT_READY"),
                               ("display_phase", "DESKTOP_START_TIMEOUT")):
            with self.subTest(mode=mode):
                self.scenario(mode, 30000, expected)

    def test_unwritable_tmp_falls_back_for_session_root_and_reports_xvnc_start_failed(self):
        options = SimpleNamespace(application="terminal", ttl_ms=30000, width=800, height=600,
                                  session_ref="a" * 48)
        real_tempdir = helper.tempfile.TemporaryDirectory

        def tempdir_fallback(prefix=None, dir=None):
            if dir is None:
                raise PermissionError("unwritable /tmp")
            return real_tempdir(prefix=prefix)

        with patch.object(helper.shutil, "which", side_effect=lambda name, **_: "/usr/bin/" + name), \
                patch.object(helper.os, "makedirs"), \
                patch.object(helper.tempfile, "TemporaryDirectory", side_effect=tempdir_fallback), \
                patch.object(helper.os, "access", return_value=False):
            with self.assertRaisesRegex(helper.SessionError, "^DESKTOP_XVNC_START_FAILED$"):
                helper.run(options)


if __name__ == "__main__":
    unittest.main()
