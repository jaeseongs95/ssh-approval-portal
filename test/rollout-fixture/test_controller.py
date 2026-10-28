import unittest
from controller import Identity, rollout


class Fake:
    def __init__(self, *, durable=False, fail=None):
        self.durable, self.fail, self.calls = durable, fail, []

    def step(self, name, value=None):
        self.calls.append(name)
        if self.fail == name:
            raise RuntimeError(name)
        return value

    def inspect(self, i):
        return self.step('inspect', dict(hostname=i.hostname, manifest=i.old_manifest, candidate=i.candidate_manifest,
            candidate_verified=True, config=i.config_fingerprint, old_instance='old', independent_channel=True, durable=self.durable))
    def claim_once(self, i): return self.step('claim', True)
    def make_owner(self, i): return self.step('owner', 'private')
    def reserve_and_capture(self, *a): return self.step('capture')
    def reserve_legacy(self, *a): return self.step('legacy-reserve')
    def backup_staging(self, *a): return self.step('staging')
    def stop_and_prove(self, *a): return self.step('stop')
    def prepare_offline_baseline(self, *a): return self.step('offline')
    def capture_protected(self, *a): return self.step('protected', 'private snapshot')
    def activate_exact(self, *a): return self.step('activate')
    def start_and_identify(self, *a): return self.step('start', 'new')
    def compare(self, *a): return self.step('compare', {'status':'PASS', 'commandRequestsChecked':1, 'cliRequestsChecked':0, 'outputsChecked':0, 'outputPayloadsVerified':0, 'outputsUnavailable':0, 'expiredOutputsRemoved':0})
    def verify_protected(self, *a): return self.step('verify')
    def release(self, *a): return self.step('release')
    def write_receipt(self, i, value): self.receipt = value


class Contract(unittest.TestCase):
    def setUp(self): self.identity = Identity('test-job', 'test-host', 'a'*64, 'b'*64, 'c'*64)
    def test_first_and_durable_transition(self):
        for durable in (False, True):
            b = Fake(durable=durable)
            self.assertTrue(rollout(self.identity, b))
            self.assertEqual('PASS', b.receipt['status'])
            self.assertLess(b.calls.index('compare'), b.calls.index('release'))
            self.assertEqual(not durable, 'offline' in b.calls)
            self.assertEqual(durable, 'capture' in b.calls)
    def test_every_failed_phase_never_releases_or_retries(self):
        for phase in ('claim','owner','legacy-reserve','staging','stop','offline','protected','activate','start','compare','verify'):
            b = Fake(fail=phase)
            self.assertFalse(rollout(self.identity, b), phase)
            self.assertNotIn('release', b.calls)
            self.assertEqual(1, b.calls.count(phase))
            if phase != 'claim': self.assertEqual('NEEDS_REVIEW', b.receipt['status'])
            else: self.assertFalse(hasattr(b, 'receipt'))
    def test_partial_never_releases(self):
        b = Fake()
        b.compare = lambda *args: {'status':'PARTIAL','outputsUnavailable':1,'expiredOutputsRemoved':0}
        self.assertFalse(rollout(self.identity, b))
        self.assertNotIn('release', b.calls)

if __name__ == '__main__': unittest.main()
