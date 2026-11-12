package io.github.jaeseongs95.portal.app.audit;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * One audit fact. Only allow-listed metadata reaches the file (2.x {@code jsonl.mjs}): the action, the operation it is about and a short note that the caller has
 * already redacted. The time is added by the audit log from the one {@code Clock}. Stage 3 adds the fields its use cases need (target, command class, hash).
 */
public record AuditEvent(AuditAction action, OperationId operationId, String note) {

    public static final int MAX_NOTE_CHARS = 512;

    public AuditEvent {
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(operationId, "operationId");
        Objects.requireNonNull(note, "note");
        if (note.length() > MAX_NOTE_CHARS) {
            throw new IllegalArgumentException("note is longer than " + MAX_NOTE_CHARS + " characters");
        }
    }
}
