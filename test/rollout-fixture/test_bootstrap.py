import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
import os

import bootstrap


class Bootstrap(unittest.TestCase):
    def setUp(self):
        if os.name != 'nt' and os.geteuid() != 0:
            self.skipTest('bootstrap requires root on Linux')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        pins = {}
        for name in bootstrap.NAMES:
            data = ('fixture:' + name).encode()
            (self.root / name).write_bytes(data)
            (self.root / name).chmod(0o600)
            pins[name] = hashlib.sha256(data).hexdigest()
        raw = json.dumps({'controllerDigests': pins}).encode()
        (self.root / 'intent.json').write_bytes(raw)
        (self.root / 'intent.json').chmod(0o600)
        self.pin = hashlib.sha256(raw).hexdigest()

    def test_all_pins_checked_before_returning_any_controller_bytes(self):
        values = bootstrap.validate(str(self.root), self.pin)
        self.assertEqual(b'fixture:run_linux.py', values['run_linux.py'])
        (self.root / 'linux_adapter.py').write_bytes(b'untrusted')
        with self.assertRaises(RuntimeError):
            bootstrap.validate(str(self.root), self.pin)

    def test_wrong_intent_pin_is_rejected(self):
        with self.assertRaises(RuntimeError):
            bootstrap.validate(str(self.root), 'f' * 64)

    def test_isolated_bootstrap_runs_only_the_pinned_modules(self):
        values = {name: b'' for name in bootstrap.NAMES}
        values['linux_adapter.py'] = b'BOUND = True\n'
        values['run_linux.py'] = b'from linux_adapter import BOUND\nfrom pathlib import Path\nimport sys\nassert BOUND\n(Path(sys.argv[1]) / "executed").write_text("yes")\n'
        pins = {}
        for name, data in values.items():
            (self.root / name).write_bytes(data)
            (self.root / name).chmod(0o600)
            pins[name] = hashlib.sha256(data).hexdigest()
        raw = json.dumps({'controllerDigests': pins}).encode()
        (self.root / 'intent.json').write_bytes(raw)
        (self.root / 'intent.json').chmod(0o600)
        pin = hashlib.sha256(raw).hexdigest()
        command = [sys.executable, '-I', '-B', str(Path(bootstrap.__file__)), str(self.root), pin]
        completed = subprocess.run(command, capture_output=True, timeout=10)
        self.assertEqual(0, completed.returncode, completed.stderr.decode(errors='replace'))
        (self.root / 'executed').unlink()
        (self.root / 'linux_adapter.py').write_bytes(b'BOUND = False\n')
        rejected = subprocess.run(command, capture_output=True, timeout=10)
        self.assertNotEqual(0, rejected.returncode)
        self.assertFalse((self.root / 'executed').exists())

if __name__ == '__main__':
    unittest.main()
