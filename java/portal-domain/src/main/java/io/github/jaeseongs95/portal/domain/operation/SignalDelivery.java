package io.github.jaeseongs95.portal.domain.operation;

import java.util.Locale;

/**
 * Whether a cancel signal was passed to the remote side (2.x public-contract.mjs:27). {@link #REQUESTED} is not a confirmed termination. {@link #NOT_SENT} means no
 * signal was asked for; it has no wire value, the contract writes it as an absent value.
 */
public enum SignalDelivery {
    NOT_SENT, REQUESTED, UNSUPPORTED;

    /** The lowercase name; for {@link #NOT_SENT} the text {@code not_sent}, which the contract never writes. */
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
