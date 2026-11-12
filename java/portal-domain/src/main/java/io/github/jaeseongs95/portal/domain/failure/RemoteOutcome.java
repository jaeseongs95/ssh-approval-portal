package io.github.jaeseongs95.portal.domain.failure;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/**
 * What is known about the remote side after a failed execution (2.x execution-failure.mjs:5): the command never started, it is unknown whether it ran, or it
 * ran to the end and a later step failed. The wire value is the lowercase name, for example {@code not_started}.
 */
public enum RemoteOutcome {
    NOT_STARTED, UNKNOWN, COMPLETED;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
