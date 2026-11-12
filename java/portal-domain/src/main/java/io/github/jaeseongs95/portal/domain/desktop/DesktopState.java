package io.github.jaeseongs95.portal.domain.desktop;

import com.fasterxml.jackson.annotation.JsonValue;

/** How far a desktop is usable (2.x desktop-state.mjs:3). The wire names are the 2.x lowercase words. */
public enum DesktopState {
    /** The connection to the desktop works, nothing about the session is known. */
    TRANSPORT_READY("transport_ready"),
    AUTH_REQUIRED("auth_required"),
    /** Session and display are verified and input is verified. */
    DESKTOP_READY("desktop_ready"),
    /** The desktop answers but no frame can be captured. */
    CAPTURE_UNAVAILABLE("capture_unavailable");

    private final String wire;

    DesktopState(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }

    /** The state of a wire name; any other text is refused. */
    public static DesktopState parse(String text) {
        for (DesktopState state : values()) {
            if (state.wire.equals(text)) {
                return state;
            }
        }
        throw new IllegalArgumentException("Unknown desktop state");
    }
}
