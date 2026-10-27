"""Real systemd, HTTP and SQLite transition using synthetic data, isolated CI only."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def request(port, path, *, owner=None):
    headers = {'Authorization': 'Bearer fixture-admin', 'Origin': 'https://example.test'}
    if owner is not None:
        headers['X-Maintenance-Owner'] = owner
    with urlopen(Request(f'http://127.0.0.1:{port}{path}', data=b'', headers=headers, method='POST'), timeout=3) as response:
        return response.status, json.load(response)


def health(port):
    with urlopen(f'http://127.0.0.1:{port}/health', timeout=3) as response:
        return json.load(response)


class SystemdTransition(unittest.TestCase):
    def test_old_service_offline_seed_new_service_and_owner_release(self):
        if os.geteuid() != 0:
            self.skipTest('isolated root fixture required')
        old, new, node = (Path(os.environ[name]) for name in ('SSH_E2E_OLD', 'SSH_E2E_NEW', 'SSH_E2E_NODE'))
        root = Path(os.environ['SSH_E2E_DIR'])
        state = root / 'state'
        state.mkdir(mode=0o700)
        script = Path(__file__).with_name('e2e-service.mjs')
        baseline = Path(__file__).with_name('e2e-baseline.mjs')
        base = os.environ['SSH_ROLLOUT_FIXTURE_UNIT'].removesuffix('.service')
        units = [base + '-old.service', base + '-new.service']
        for unit in units:
            result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '-p', 'LoadState', '--value'], capture_output=True, text=True, check=True)
            self.assertEqual('not-found', result.stdout.strip())
        admin, mcp = free_port(), free_port()
        self.assertNotEqual(admin, mcp)
        def start(unit, source):
            subprocess.run(['/usr/bin/systemd-run', '--unit=' + unit, '--property=Type=simple', str(node), str(script), str(source), str(state), str(admin), str(mcp)], check=True, timeout=30, capture_output=True)
            for _ in range(100):
                try:
                    if health(mcp).get('healthy') is True:
                        return
                except (OSError, URLError, ValueError):
                    pass
                time.sleep(.1)
            self.fail('fixture service did not become healthy')
        owner = 'a' * 64
        try:
            start(units[0], old)
            status, result = request(admin, '/api/maintenance/reserve')
            self.assertEqual((200, True), (status, result.get('reserved')))
            self.assertTrue(health(mcp)['maintenance'])
            subprocess.run(['/usr/bin/systemctl', 'stop', units[0]], check=True, timeout=30)
            seeded = subprocess.run([str(node), str(baseline), str(new), str(state)], input=owner, text=True, capture_output=True, timeout=30)
            self.assertEqual(0, seeded.returncode, seeded.stderr)
            start(units[1], new)
            self.assertTrue(health(mcp)['maintenance'])
            with self.assertRaises(HTTPError) as mismatch:
                request(admin, '/api/maintenance/release', owner='b' * 64)
            self.assertEqual(409, mismatch.exception.code)
            status, result = request(admin, '/api/maintenance/preservation/compare', owner=owner)
            self.assertEqual(200, status)
            self.assertEqual('PASS', result['status'])
            self.assertEqual(0, result['outputsUnavailable'])
            status, result = request(admin, '/api/maintenance/release', owner=owner)
            self.assertEqual((200, True), (status, result.get('released')))
            self.assertFalse(health(mcp)['maintenance'])
        finally:
            for unit in units:
                subprocess.run(['/usr/bin/systemctl', 'stop', unit], check=False, timeout=30, capture_output=True)

if __name__ == '__main__':
    unittest.main()
