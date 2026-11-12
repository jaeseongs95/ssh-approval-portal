package io.github.jaeseongs95.portal.ssh.hostkey;

import java.net.SocketAddress;
import java.security.PublicKey;

import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;

import io.github.jaeseongs95.portal.domain.target.Setting;

/**
 * Checks the host key of a profile that pins one: only the pinned key is accepted, whatever the mode is (CR-19). When the key is the pinned one and the mode is {@code tofu},
 * it is also put in the record of known hosts if the host is not in it yet, so a later profile without a pin finds the host known. A key that is not the pin is refused
 * with {@link HostKeyRefusal.Reason#PIN_MISMATCH}, in every mode, and nothing is recorded.
 */
final class PinnedKeyVerifier implements ServerKeyVerifier {

    private final PinnedFingerprintVerifier pin;
    private final RecordedKeyVerifier recorded;
    private final HostKeyEvents events;

    PinnedKeyVerifier(PinnedFingerprintVerifier pin, RecordedKeyVerifier recorded, HostKeyEvents events) {
        this.pin = pin;
        this.recorded = recorded;
        this.events = events;
    }

    @Override
    public boolean verifyServerKey(ClientSession session, SocketAddress remoteAddress, PublicKey serverKey) {
        if (!pin.matches(serverKey)) {
            events.refused(HostKeyRefusal.at(HostKeyRefusal.Reason.PIN_MISMATCH, remoteAddress, HostKeyFingerprint.of(serverKey), Setting.given(pin.pin())));
            return false;
        }
        recorded.recordFirstUse(session, remoteAddress, serverKey);
        return true;
    }
}
