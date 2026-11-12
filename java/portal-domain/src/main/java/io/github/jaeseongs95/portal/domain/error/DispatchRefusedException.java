package io.github.jaeseongs95.portal.domain.error;

import java.io.Serial;
import java.util.Objects;

/**
 * A dispatch that stopped before any remote effect (a guard failed, a claim was lost, a persistence step failed). What leaves the process is the closed
 * {@link DispatchFailure} (reason and stage); the message is a fixed sentence and the caught exception, if any, is the {@code cause} only (dispatch-failure.mjs:1-2).
 *
 * <p>The failure is {@code transient}: it is a diagnostic value of this process and is not part of a serialised exception.
 */
public final class DispatchRefusedException extends PortalException {

    @Serial
    private static final long serialVersionUID = 1L;

    private final transient DispatchFailure failure;

    public DispatchRefusedException(DispatchFailure failure) {
        this(failure, null);
    }

    public DispatchRefusedException(DispatchFailure failure, Throwable cause) {
        super("Dispatch refused before any remote effect", cause);
        this.failure = Objects.requireNonNull(failure, "failure");
    }

    public DispatchFailure failure() {
        return failure;
    }
}
