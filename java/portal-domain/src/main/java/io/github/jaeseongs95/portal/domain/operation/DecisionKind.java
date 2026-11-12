package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/** What the automatic approval decided: run it, leave it to the owner, or refuse it (2.x command-automation.mjs:134-159). The wire value is the lowercase name. */
public enum DecisionKind {
    EXECUTE, REVIEW, DENY;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
