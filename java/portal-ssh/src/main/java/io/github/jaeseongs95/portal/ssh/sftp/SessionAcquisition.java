package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import java.util.Objects;

/** What a {@link SessionSource} answers: a leased session, or the reason there is none. */
public sealed interface SessionAcquisition permits SessionAcquisition.Acquired, SessionAcquisition.Unavailable {

    /**
     * A session is leased; the caller closes the lease.
     *
     * @param lease the lease
     */
    record Acquired(SessionLease lease) implements SessionAcquisition {
        public Acquired {
            Objects.requireNonNull(lease, "lease");
        }
    }

    /**
     * No session: the connection, the authentication or the host key failed ({@link TransferFailureCause#CONNECT_FAILED}), the owner cancelled or the time ran out
     * while it was made. Nothing was sent to the target.
     *
     * @param cause why
     */
    record Unavailable(TransferFailureCause cause) implements SessionAcquisition {
        public Unavailable {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
