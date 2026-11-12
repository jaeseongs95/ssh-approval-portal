package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * A request to open a {@code direct-tcpip} channel from the target to a host and port the target can reach. Only the name and the shape are fixed in stage 3; the
 * desktop module (stage 5) implements the use and may refine the fields.
 *
 * @param target the target whose connection carries the channel
 * @param host the host the target connects to, 1 to 253 characters
 * @param port the port, 1 to 65535
 */
public record ForwardRequest(RemoteTarget target, String host, int port) {

    public ForwardRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(host, "host");
        if (host.isBlank() || host.length() > 253 || port < 1 || port > 65535) {
            throw new IllegalArgumentException("A forward needs a host of 1 to 253 characters and a port from 1 to 65535");
        }
    }
}
