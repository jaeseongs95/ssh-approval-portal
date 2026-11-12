package io.github.jaeseongs95.portal.ssh.hostkey;

import java.net.SocketAddress;
import java.security.PublicKey;

import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;

import io.github.jaeseongs95.portal.app.remote.HostKeyMode;
import io.github.jaeseongs95.portal.domain.target.Setting;

/**
 * Checks the host key of a profile that pins none, by the mode of the installation: {@code tofu} records the first key of a host and refuses a different one later,
 * {@code strict} accepts only a host that is already recorded, {@code insecure} accepts every key (CR-20 to CR-22). The record is the {@code known_hosts} file behind
 * {@link ObservingKnownHosts}; in {@code insecure} mode there is none. A refusal is reported to {@link HostKeyEvents} once.
 */
final class RecordedKeyVerifier implements ServerKeyVerifier {

    private final HostKeyMode mode;
    private final ServerKeyVerifier knownHosts;
    private final HostKeyEvents events;

    /** @param knownHosts the verifier that holds the record; not asked in {@code insecure} mode */
    RecordedKeyVerifier(HostKeyMode mode, ServerKeyVerifier knownHosts, HostKeyEvents events) {
        this.mode = mode;
        this.knownHosts = knownHosts;
        this.events = events;
    }

    @Override
    public boolean verifyServerKey(ClientSession session, SocketAddress remoteAddress, PublicKey serverKey) {
        if (mode == HostKeyMode.INSECURE) {
            return true;
        }
        boolean accepted = knownHosts.verifyServerKey(session, remoteAddress, serverKey);
        if (!accepted) {
            HostKeyRefusal.Reason reason = session.getAttribute(ObservingKnownHosts.REASON);
            HostKeyFingerprint recorded = session.getAttribute(ObservingKnownHosts.RECORDED);
            events.refused(HostKeyRefusal.at(reason != null ? reason : HostKeyRefusal.Reason.UNKNOWN, remoteAddress, HostKeyFingerprint.of(serverKey),
                recorded != null ? Setting.given(recorded.text()) : Setting.unset()));
        }
        return accepted;
    }

    /**
     * The key of a pinned profile, which the pin has already accepted, is put in the record when the mode is {@code tofu} (CR-19): a host that is not recorded yet gets the key,
     * a host that is recorded keeps what it has, and nothing is recorded in the other modes. What the record says about the key does not matter to the connection, so the
     * answer of the record is not used and a different recorded key is not reported.
     */
    void recordFirstUse(ClientSession session, SocketAddress remoteAddress, PublicKey serverKey) {
        if (mode == HostKeyMode.TOFU) {
            knownHosts.verifyServerKey(session, remoteAddress, serverKey);
        }
    }
}
