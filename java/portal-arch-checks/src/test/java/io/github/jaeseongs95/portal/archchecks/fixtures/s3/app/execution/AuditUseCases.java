package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.execution;

import io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.audit.AuditFailedException;

// app.execution fixtures for A-AUDIT-BOUNDARY (RuleFixturesTest): one lets the infrastructure exception out of a public method, one converts it at its boundary.

/** Declares AuditFailedException in a public method: A-AUDIT-BOUNDARY. */
final class LeaksAuditFailure {
    public void run() throws AuditFailedException {
        throw new AuditFailedException("x");
    }
}

/** Converts the infrastructure exception into the use case's own refusal: the allowed shape. No rule may flag it. */
final class ConvertsAuditFailure {
    public void run() {
        try {
            audit();
        } catch (AuditFailedException failure) {
            throw new IllegalStateException("refused: the audit line is not durable", failure);
        }
    }

    private void audit() {
        throw new AuditFailedException("x");
    }
}
