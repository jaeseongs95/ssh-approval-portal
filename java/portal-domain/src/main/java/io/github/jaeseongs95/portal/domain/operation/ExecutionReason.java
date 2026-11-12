package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/** Why an execution ended (2.x public-contract.mjs:24). The wire value is the lowercase name, for example {@code transport_lost}. */
public enum ExecutionReason {
    EXIT, DEADLINE, CANCEL, TRANSPORT_LOST, CHANNEL_OPEN_FAILED, INPUT_FAILED;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
