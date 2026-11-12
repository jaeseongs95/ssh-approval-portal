package io.github.jaeseongs95.portal.store.audit;

import io.github.jaeseongs95.portal.app.audit.AuditAction;

/** One line of the JSONL file: the time (ISO-8601 UTC), the action (its wire value, through the {@code @JsonValue} of the enum), the operation id and the note. */
record AuditLine(String at, AuditAction action, String id, String note) {
}
