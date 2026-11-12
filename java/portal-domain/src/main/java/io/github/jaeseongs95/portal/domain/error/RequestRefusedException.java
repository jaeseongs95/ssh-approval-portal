package io.github.jaeseongs95.portal.domain.error;

import java.io.Serial;
import java.util.Objects;

/**
 * A request the portal refused or could not answer, with the three facts the public envelope carries: the {@link ErrorCode}, whether a retry can help and what
 * may have happened on the target. The short constructor takes the defaults of the code (stage 2 design 5.5); a throw site that knows more passes all three.
 */
public final class RequestRefusedException extends PortalException {

    @Serial
    private static final long serialVersionUID = 1L;

    private final ErrorCode code;
    private final boolean retryable;
    private final ExecutionAttempt attempt;

    public RequestRefusedException(ErrorCode code) {
        this(code, Objects.requireNonNull(code, "code").retryableByDefault(), code.attemptByDefault(), null);
    }

    public RequestRefusedException(ErrorCode code, Throwable cause) {
        this(code, Objects.requireNonNull(code, "code").retryableByDefault(), code.attemptByDefault(), cause);
    }

    public RequestRefusedException(ErrorCode code, boolean retryable, ExecutionAttempt attempt) {
        this(code, retryable, attempt, null);
    }

    public RequestRefusedException(ErrorCode code, boolean retryable, ExecutionAttempt attempt, Throwable cause) {
        super("Request refused: " + Objects.requireNonNull(code, "code").name(), cause);
        this.code = code;
        this.retryable = retryable;
        this.attempt = Objects.requireNonNull(attempt, "attempt");
    }

    public ErrorCode code() {
        return code;
    }

    public boolean retryable() {
        return retryable;
    }

    public ExecutionAttempt attempt() {
        return attempt;
    }
}
