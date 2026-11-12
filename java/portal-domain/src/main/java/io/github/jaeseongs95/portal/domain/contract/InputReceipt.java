package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * The {@code data} of {@code desktop-input} and the {@code lastInputReceipt} of a session (public-contract.mjs:244, {@code inputReceipt}): proof that the portal sent
 * the input of a sequence. {@code state} is the constant {@code "sent"}; {@link #SENT} names it. 2.x neither limits nor patterns {@code requestKey} here, so this
 * record does not either.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record InputReceipt(String sessionId, long sequence, String requestKey, String state) {

    /** The only state of a receipt. */
    public static final String SENT = "sent";

    public InputReceipt {
        WireFormat.SESSION_ID.require(sessionId, "sessionId");
        WireNumber.POSITIVE.require(sequence, "sequence");
        Objects.requireNonNull(requestKey, "requestKey");
        if (!SENT.equals(state)) {
            throw new IllegalArgumentException("state must be " + SENT);
        }
    }
}
