package io.github.jaeseongs95.portal.domain.error;

import java.io.Serial;
import java.util.Objects;

/**
 * An execution that failed after the remote effect may have started. Only the closed {@link ExecutionFailure} (stage, code, remote outcome) is a diagnostic;
 * the message is a fixed sentence and the caught exception is the {@code cause} only (execution-failure.mjs:1-6). An automatic replay is never allowed, so
 * there is no field for it.
 *
 * <p>The failure is {@code transient}: it is a diagnostic value of this process and is not part of a serialised exception.
 */
public final class ExecutionFailedException extends PortalException {

    @Serial
    private static final long serialVersionUID = 1L;

    private final transient ExecutionFailure failure;

    public ExecutionFailedException(ExecutionFailure failure) {
        this(failure, null);
    }

    public ExecutionFailedException(ExecutionFailure failure, Throwable cause) {
        super("Execution failed", cause);
        this.failure = Objects.requireNonNull(failure, "failure");
    }

    public ExecutionFailure failure() {
        return failure;
    }
}
