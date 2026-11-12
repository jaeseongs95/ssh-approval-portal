package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.file;

import io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.audit.AuditFailedException;

/** The app.file side of A-AUDIT-BOUNDARY: a public method that declares the infrastructure exception (RuleFixturesTest). */
final class LeaksFileAuditFailure {
    public void upload() throws AuditFailedException {
        throw new AuditFailedException("x");
    }
}
