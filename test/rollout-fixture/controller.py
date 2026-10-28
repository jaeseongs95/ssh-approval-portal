"""Pinned, fail-closed orchestration for a durable maintenance rollout.

Backend operations are deliberately supplied by a separate, audited host adapter.
This module does not change a host on its own.
"""
from dataclasses import dataclass
import re

HEX = re.compile(r'^[0-9a-f]{64}$')


@dataclass(frozen=True)
class Identity:
    job: str
    hostname: str
    old_manifest: str
    candidate_manifest: str
    config_fingerprint: str

    def __post_init__(self):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', self.job):
            raise ValueError('invalid job')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}', self.hostname):
            raise ValueError('invalid host')
        if not all(HEX.fullmatch(item) for item in (self.old_manifest, self.candidate_manifest, self.config_fingerprint)):
            raise ValueError('invalid fingerprint')
        if self.old_manifest == self.candidate_manifest:
            raise ValueError('candidate and current release are identical')


def rollout(identity, backend):
    """One attempt only. Failure never triggers retry, rollback, or release.

    Each adapter method must either return explicit evidence or raise. The backend
    binds all mutations to identity and implements protected, durable receipts.
    """
    phase = 'validate'
    claimed = False
    try:
        state = backend.inspect(identity)
        if state['hostname'] != identity.hostname or state['manifest'] != identity.old_manifest or state['config'] != identity.config_fingerprint:
            raise RuntimeError('target prestate mismatch')
        if state['candidate'] != identity.candidate_manifest or not state['candidate_verified']:
            raise RuntimeError('candidate mismatch')
        if not state['old_instance'] or not state['independent_channel']:
            raise RuntimeError('instance or recovery channel missing')
        if not backend.claim_once(identity):
            raise RuntimeError('job already claimed')
        claimed = True
        phase = 'reserve'
        owner = backend.make_owner(identity)
        if not owner:
            raise RuntimeError('owner unavailable')
        if state['durable']:
            backend.reserve_and_capture(identity, owner, state['old_instance'])
        else:
            backend.reserve_legacy(identity, state['old_instance'])
        phase = 'staging-backup'
        backend.backup_staging(identity, state['old_instance'])
        phase = 'stop'
        backend.stop_and_prove(identity, state['old_instance'])
        if not state['durable']:
            phase = 'offline-baseline'
            backend.prepare_offline_baseline(identity, owner)
        phase = 'protect'
        protected = backend.capture_protected(identity)
        if not protected:
            raise RuntimeError('protected baseline unavailable')
        phase = 'activate'
        backend.activate_exact(identity)
        phase = 'start'
        instance = backend.start_and_identify(identity)
        if not instance or instance == state['old_instance']:
            raise RuntimeError('new instance not proven')
        phase = 'compare'
        result = backend.compare(identity, owner, instance)
        counts = ('commandRequestsChecked', 'cliRequestsChecked', 'outputsChecked', 'outputPayloadsVerified', 'outputsUnavailable', 'expiredOutputsRemoved')
        if result.get('status') != 'PASS' or any(type(result.get(key)) is not int or result[key] < 0 for key in counts) or result['outputsUnavailable'] != 0 or result['expiredOutputsRemoved'] != 0:
            raise RuntimeError('preservation incomplete')
        backend.verify_protected(identity, protected, instance)
        phase = 'release'
        backend.release(identity, owner, instance)
        phase = 'finish'
        backend.write_receipt(identity, {'status': 'PASS', 'phase': phase, 'instance': instance, 'comparison': result})
        return True
    except Exception as exc:
        if claimed:
            backend.write_receipt(identity, {'status': 'NEEDS_REVIEW', 'phase': phase, 'errorType': type(exc).__name__,
                                             # Controller RuntimeErrors carry fixed reason strings only (no paths/secrets).
                                             'error': str(exc) if type(exc) is RuntimeError else None,
                                             'subphase': getattr(backend, 'subphase', None) if phase == 'offline-baseline' else None})
        return False
