import json
from pathlib import Path
import tempfile
import unittest
from protected_state import capture, compare


class ProtectedState(unittest.TestCase):
    def test_append_only_audit_and_exact_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            config, audit = root/'config', root/'audit'
            config.write_bytes(b'old'); audit.write_bytes(b'first')
            baseline = json.loads(json.dumps(capture([config], audit)))
            with audit.open('ab') as stream: stream.write(b'second')
            self.assertTrue(compare(baseline))
            config.write_bytes(b'new')
            with self.assertRaises(RuntimeError): compare(baseline)
    def test_audit_prefix_tamper_and_truncation_rejected(self):
        for content in (b'changed', b'a'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve(); audit = root/'audit'
                audit.write_bytes(b'abc')
                baseline = capture([], audit)
                audit.write_bytes(content)
                with self.assertRaises(RuntimeError): compare(baseline)

if __name__ == '__main__': unittest.main()
