package io.github.jaeseongs95.portal.app.audit;

import java.io.Serial;

/**
 * The audit line could not be made durable. The approval that needed it must not go on: a zero-byte or partial write that is not completed counts as no audit
 * (2.x {@code writeAll}). It is the one failure of this module that is not a {@code PortalException}: that hierarchy is sealed in portal-domain and has no variant
 * for a storage failure yet (reported as a need); until it has, the cause is carried and the use case of stage 3 turns this into its dispatch refusal.
 */
public final class AuditFailedException extends RuntimeException {

    @Serial
    private static final long serialVersionUID = 1L;

    public AuditFailedException(String message, Throwable cause) {
        super(message, cause);
    }

    public AuditFailedException(String message) {
        super(message);
    }
}
