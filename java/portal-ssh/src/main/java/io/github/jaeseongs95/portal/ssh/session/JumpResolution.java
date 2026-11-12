package io.github.jaeseongs95.portal.ssh.session;

import java.util.List;
import java.util.Objects;

/** The answer of {@link ProxyJumpResolver}: the servers of the connection in the order they are passed, or why the chain cannot be made. */
public sealed interface JumpResolution permits JumpResolution.Resolved, JumpResolution.Failed {

    /**
     * The chain is complete.
     *
     * @param hops the jump hosts in the order they are connected, the target last; never empty
     */
    record Resolved(List<Hop> hops) implements JumpResolution {
        public Resolved {
            hops = List.copyOf(hops);
            if (hops.isEmpty()) {
                throw new IllegalArgumentException("A connection has at least the target");
            }
        }

        /** The server the request is for. */
        public Hop target() {
            return hops.get(hops.size() - 1);
        }
    }

    /** The chain cannot be made. */
    record Failed(ConnectFailure failure) implements JumpResolution {
        public Failed {
            Objects.requireNonNull(failure, "failure");
        }
    }
}
