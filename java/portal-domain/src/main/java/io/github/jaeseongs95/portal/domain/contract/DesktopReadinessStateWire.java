package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code readiness.state} on the wire (public-contract.mjs:246): {@code transport_ready} is not {@code desktop_ready}. */
public enum DesktopReadinessStateWire {
    TRANSPORT_READY("transport_ready"), AUTH_REQUIRED("auth_required"), DESKTOP_READY("desktop_ready"), CAPTURE_UNAVAILABLE("capture_unavailable");

    private final String wire;

    DesktopReadinessStateWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
