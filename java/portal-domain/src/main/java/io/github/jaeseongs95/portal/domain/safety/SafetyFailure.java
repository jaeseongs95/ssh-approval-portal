package io.github.jaeseongs95.portal.domain.safety;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Why a safety evaluation produced no assessment. A closed vocabulary: no provider text, payload, numeric metadata or credential is part of a failure
 * (safety.mjs:15-16, 83-86).
 */
public enum SafetyFailure {
    NOT_CONFIGURED("not_configured"),
    BUSY("busy"),
    INVALID_INPUT("invalid_input"),
    INPUT_TOO_LARGE("input_too_large"),
    TIMEOUT("timeout"),
    HTTP_ERROR("http_error"),
    INVALID_RESPONSE("invalid_response"),
    RESPONSE_TOO_LARGE("response_too_large"),
    REQUEST_FAILED("request_failed");

    private final String wire;

    SafetyFailure(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
