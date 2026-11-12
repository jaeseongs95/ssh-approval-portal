package io.github.jaeseongs95.portal.ssh.hostkey;

import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.Setting;

/**
 * A host key that was refused, with what an operator needs to judge it. It holds public data only (the address and fingerprints).
 *
 * @param reason why the key was refused
 * @param host the host the connection went to
 * @param port the port
 * @param received the fingerprint of the key the host presented
 * @param expected the fingerprint that was expected, when there is one: the pin, or the recorded key
 */
public record HostKeyRefusal(Reason reason, String host, int port, HostKeyFingerprint received, Setting<String> expected) {

    /** Why a host key is refused; {@link #code()} is the name 2.x gave it (vendor ssh/host-key.js). */
    public enum Reason {
        /** The key is not the pinned key (2.x {@code HOST_KEY_PIN_MISMATCH}). */
        PIN_MISMATCH("HOST_KEY_PIN_MISMATCH"),
        /** The host is recorded with another key (2.x {@code HOST_KEY_MISMATCH}). */
        CHANGED("HOST_KEY_MISMATCH"),
        /** The host is not recorded and the mode is strict (2.x {@code HOST_KEY_UNKNOWN}). */
        UNKNOWN("HOST_KEY_UNKNOWN");

        private final String code;

        Reason(String code) {
            this.code = code;
        }

        /** The name of the reason as 2.x wrote it. */
        public String code() {
            return code;
        }
    }

    public HostKeyRefusal {
        Objects.requireNonNull(reason, "reason");
        Objects.requireNonNull(host, "host");
        Objects.requireNonNull(received, "received");
        Objects.requireNonNull(expected, "expected");
    }

    /** A refusal for a connection to the remote address MINA reports: its host and port when it is an IP address, its text otherwise. */
    public static HostKeyRefusal at(Reason reason, SocketAddress remote, HostKeyFingerprint received, Setting<String> expected) {
        return remote instanceof InetSocketAddress inet ? new HostKeyRefusal(reason, inet.getHostString(), inet.getPort(), received, expected)
            : new HostKeyRefusal(reason, String.valueOf(remote), 0, received, expected);
    }

    /** The sentence for the log and for the operator: the code, the host and the fingerprints. */
    public String describe() {
        String known = expected.isGiven() ? " expected " + expected.orElse("") + "," : "";
        return reason.code() + ": the key presented by " + host + ":" + port + " was refused;" + known + " received " + received;
    }
}
