package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.audit;

import java.io.Serial;

/** Stands for portal-app's AuditFailedException (an unchecked infrastructure exception) for A-AUDIT-BOUNDARY. */
public final class AuditFailedException extends RuntimeException {

    @Serial
    private static final long serialVersionUID = 1L;

    public AuditFailedException(String message) {
        super(message);
    }
}
