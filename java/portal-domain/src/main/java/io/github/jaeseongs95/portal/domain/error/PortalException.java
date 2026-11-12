package io.github.jaeseongs95.portal.domain.error;

import java.io.Serial;

/**
 * Every business failure of the portal is one of three variants: a request that was refused with a contract code ({@link RequestRefusedException}), a dispatch
 * that stopped before any remote effect ({@link DispatchRefusedException}) or an execution that failed after one ({@link ExecutionFailedException}). A caller
 * that needs the distinction matches on the variant; the one place that turns an exception into an answer handles all three. Programming errors (a null
 * argument, a violated value invariant) are not business failures and stay {@link IllegalArgumentException} and {@link NullPointerException}.
 *
 * <p>The message is a fixed sentence: text that came from a remote host, a caught exception or the caller never becomes part of a diagnostic (dispatch-failure.mjs:1).
 */
public abstract sealed class PortalException extends RuntimeException permits RequestRefusedException, DispatchRefusedException, ExecutionFailedException {

    @Serial
    private static final long serialVersionUID = 1L;

    protected PortalException(String message, Throwable cause) {
        super(message, cause);
    }
}
