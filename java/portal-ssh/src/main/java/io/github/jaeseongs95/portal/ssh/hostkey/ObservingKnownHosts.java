package io.github.jaeseongs95.portal.ssh.hostkey;

import java.net.SocketAddress;
import java.nio.file.Path;
import java.security.PublicKey;

import org.apache.sshd.client.config.hosts.KnownHostEntry;
import org.apache.sshd.client.keyverifier.DefaultKnownHostsServerKeyVerifier;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.AttributeRepository;

/**
 * MINA's known-hosts verifier, which keeps the record in an OpenSSH {@code known_hosts} file (decision D3-10), with one addition: when it refuses a key it leaves the reason
 * on the session, so the policy can report why (MINA answers only {@code false}). The behavior is MINA's own and is the one the stage 1 spike tested ({@code s07},
 * {@code s08}): a host that is not in the file is put to {@code unknownHosts} and recorded when that accepts; a host whose recorded key differs is refused and the file
 * stays as it was. With {@code strict} set, MINA also distrusts a file that other accounts may change.
 */
final class ObservingKnownHosts extends DefaultKnownHostsServerKeyVerifier {

    /** Why the last key of the session was refused; set only when it was refused here. */
    static final AttributeRepository.AttributeKey<HostKeyRefusal.Reason> REASON = new AttributeRepository.AttributeKey<>();
    /** The fingerprint of the recorded key, when the reason is {@code CHANGED}. */
    static final AttributeRepository.AttributeKey<HostKeyFingerprint> RECORDED = new AttributeRepository.AttributeKey<>();

    /**
     * @param unknownHosts decides about a host that is not in the file: accept it ({@code tofu}) or refuse it ({@code strict})
     * @param file the {@code known_hosts} file
     */
    ObservingKnownHosts(ServerKeyVerifier unknownHosts, Path file) {
        super(unknownHosts, true, file);
    }

    @Override
    protected boolean acceptUnknownHostKey(ClientSession session, SocketAddress remoteAddress, PublicKey serverKey) {
        boolean accepted = super.acceptUnknownHostKey(session, remoteAddress, serverKey);
        if (!accepted) {
            session.setAttribute(REASON, HostKeyRefusal.Reason.UNKNOWN);
        }
        return accepted;
    }

    @Override
    public boolean acceptModifiedServerKey(ClientSession session, SocketAddress remoteAddress, KnownHostEntry entry, PublicKey expected, PublicKey actual) throws Exception {
        boolean accepted = super.acceptModifiedServerKey(session, remoteAddress, entry, expected, actual);
        if (!accepted) {
            session.setAttribute(REASON, HostKeyRefusal.Reason.CHANGED);
            session.setAttribute(RECORDED, HostKeyFingerprint.of(expected));
        }
        return accepted;
    }
}
