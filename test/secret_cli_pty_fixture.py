"""Exercise the operator's real TTY path using only disposable synthetic secrets."""
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time

node, script = sys.argv[1:]

def terminal(args, value, cancel=False):
    master, slave = pty.openpty()
    child = subprocess.Popen([node, script, *args], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()
    sent = 0
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 16384:
                    raise AssertionError('Unexpected fixture output size')
                if sent == 0 and b'Secret value (hidden): ' in output:
                    os.write(master, value.encode() + (b'\x03' if cancel else b'\n'))
                    sent = 1
                if sent == 1 and not cancel and b'Confirm value (hidden): ' in output:
                    os.write(master, value.encode() + b'\n')
                    sent = 2
            if child.poll() is not None:
                break
        code = child.wait(timeout=2)
        assert code == (1 if cancel else 0), 'CLI fixture exit mismatch'
        assert value.encode() not in output, 'Synthetic value was echoed by TTY'
        assert (b'input_cancelled' if cancel else b'"stored":true') in output, 'Missing fixture outcome'
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=2)
        os.close(master)

with tempfile.TemporaryDirectory(prefix='ssh-secret-pty-') as directory:
    os.chmod(directory, 0o700)
    store = Path(directory) / 'secrets'
    prefix = ['--store', str(store)]
    subprocess.run([node, script, *prefix, 'init'], check=True, capture_output=True)
    reference = 'secret://local-file/model-key'
    terminal([*prefix, 'set', reference], 'synthetic-tty-first')
    before = json.loads((store / 'model-key.json').read_text())
    assert before['value'] == 'synthetic-tty-first'
    terminal([*prefix, 'set', reference], 'synthetic-tty-rotated')
    after = json.loads((store / 'model-key.json').read_text())
    assert after['value'] == 'synthetic-tty-rotated' and before['revision'] != after['revision']
    terminal([*prefix, 'set', reference], 'synthetic-tty-cancelled', cancel=True)
    assert json.loads((store / 'model-key.json').read_text()) == after
    status = subprocess.run([node, script, *prefix, 'status', reference], check=True, capture_output=True, text=True)
    assert json.loads(status.stdout)['present'] is True
    assert 'synthetic-' not in status.stdout + status.stderr
print('TTY register/rotate/cancel: PASS; synthetic values not echoed; prior value preserved on cancel')
