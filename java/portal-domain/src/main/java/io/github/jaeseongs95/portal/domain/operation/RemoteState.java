package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/**
 * What is known of the remote process at the end of an execution (2.x public-contract.mjs:25). The wire value is the lowercase name, for example {@code not_dispatched}.
 * In a read-only operation (a download) {@link #NOT_DISPATCHED} means that no request that changes the state of the target was sent (stage 3 design, decision D3-17).
 */
public enum RemoteState {
    NOT_DISPATCHED, EXITED, UNKNOWN;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
