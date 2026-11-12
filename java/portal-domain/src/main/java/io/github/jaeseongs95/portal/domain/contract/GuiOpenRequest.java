package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/** The server-issued key an agent passes to {@code desktop-open} and when it stops being valid (public-contract.mjs:50, {@code openRequest}). Time is epoch milliseconds. */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record GuiOpenRequest(String requestKey, long expiresAt) {

    public GuiOpenRequest {
        WireFormat.OPEN_REQUEST_KEY.require(requestKey, "requestKey");
        WireNumber.NON_NEGATIVE.require(expiresAt, "expiresAt");
    }
}
