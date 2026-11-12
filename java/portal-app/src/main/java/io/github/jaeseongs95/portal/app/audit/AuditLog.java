package io.github.jaeseongs95.portal.app.audit;

/** The durable audit port. {@link #append} returns only after the line is on disk. */
public interface AuditLog {

    /** @throws AuditFailedException when the line did not become durable; the caller must not approve then */
    void append(AuditEvent event);
}
