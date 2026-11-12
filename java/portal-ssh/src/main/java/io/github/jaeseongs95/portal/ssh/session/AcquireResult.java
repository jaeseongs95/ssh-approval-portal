package io.github.jaeseongs95.portal.ssh.session;

import java.util.Objects;

/**
 * The answer of {@link SshSessionPool#acquire}. Nothing is thrown for what happens on the network: a failed connection, a full session and a cancel are values, and each
 * one means that nothing was sent to the target.
 */
public sealed interface AcquireResult permits AcquireResult.Leased, AcquireResult.Failed, AcquireResult.NoChannelPermit, AcquireResult.Cancelled {

    /** A live session and the right to open one channel on it; the caller closes the lease. */
    record Leased(ChannelLease lease) implements AcquireResult {
        public Leased {
            Objects.requireNonNull(lease, "lease");
        }
    }

    /** No session could be made (stage 3 design 3.2 P1, defect D-0038: this is {@code SSH_CONNECT_FAILED}, not a full queue and not a lost transport). */
    record Failed(ConnectFailure failure) implements AcquireResult {
        public Failed {
            Objects.requireNonNull(failure, "failure");
        }
    }

    /** The session already has its permitted number of channels open; no channel was opened (stage 3 design 3.5, item 5). */
    record NoChannelPermit() implements AcquireResult {
    }

    /** The owner asked to stop while the session was being made or checked. */
    record Cancelled() implements AcquireResult {
    }
}
