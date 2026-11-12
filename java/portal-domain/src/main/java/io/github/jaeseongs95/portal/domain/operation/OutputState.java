package io.github.jaeseongs95.portal.domain.operation;

import java.util.Locale;

/** Whether the captured output is the whole output (2.x public-contract.mjs:31). {@link #NOT_REPORTED} for an execution without output; the contract writes it as an absent value. */
public enum OutputState {
    NOT_REPORTED, PARTIAL, COMPLETE;

    /** The lowercase name; for {@link #NOT_REPORTED} the text {@code not_reported}, which the contract never writes. */
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
