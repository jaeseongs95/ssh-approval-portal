package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/** Who started an operation: the owner approved it, or the server's own policy did. {@link #NOT_DECIDED} until the operation is queued (2.x approval-queue.mjs:166). */
public enum ApprovalMode {
    OWNER, AUTOMATIC, NOT_DECIDED;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
