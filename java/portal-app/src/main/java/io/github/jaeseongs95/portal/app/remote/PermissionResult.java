package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;

/** How setting the permission bits of a file ended. A target that cannot do it answers {@link Unsupported}; it never throws. */
public sealed interface PermissionResult permits PermissionResult.Applied, PermissionResult.Unsupported, PermissionResult.Refused, PermissionResult.Unconfirmed,
    PermissionResult.NotDispatched {

    /** The bits are set and read back. */
    record Applied() implements PermissionResult {
    }

    /**
     * The target cannot set permission bits; SFTP was not called.
     *
     * @param reason why not
     */
    record Unsupported(UnsupportedReason reason) implements PermissionResult {

        public Unsupported {
            Objects.requireNonNull(reason, "reason");
        }
    }

    /**
     * The target refused; the bits are unchanged.
     *
     * @param code why
     * @param diagnostic the closed fact behind the code
     */
    record Refused(TransferErrorCode code, FileDiagnostic diagnostic) implements PermissionResult {

        public Refused {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(diagnostic, "diagnostic");
        }
    }

    /**
     * The connection was lost after the request: the bits may or may not be set.
     *
     * @param cause why it is not known
     */
    record Unconfirmed(UnconfirmedCause cause) implements PermissionResult {

        public Unconfirmed {
            Objects.requireNonNull(cause, "cause");
        }
    }

    /**
     * Nothing was sent: the connection failed, the time ran out or the owner cancelled first.
     *
     * @param cause why
     */
    record NotDispatched(TransferFailureCause cause) implements PermissionResult {

        public NotDispatched {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
