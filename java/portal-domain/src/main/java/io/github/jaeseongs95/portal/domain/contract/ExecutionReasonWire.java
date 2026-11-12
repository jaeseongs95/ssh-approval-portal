package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code executionData.reason} on the wire (public-contract.mjs:24): why the execution ended. */
public enum ExecutionReasonWire {
    EXIT("exit"), DEADLINE("deadline"), CANCEL("cancel"), TRANSPORT_LOST("transport_lost"), CHANNEL_OPEN_FAILED("channel_open_failed"), INPUT_FAILED("input_failed");

    private final String wire;

    ExecutionReasonWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
