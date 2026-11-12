package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * {@code readiness.blockers[]} on the wire (public-contract.mjs:249-250): why the desktop is not ready. The wire value is the constant name, the same text as the
 * {@link DesktopErrorCode} of that name; the two are separate types because one is an error answer and the other is a status value.
 */
public enum DesktopBlockerWire {
    DESKTOP_AUTH_REQUIRED, DESKTOP_SESSION_BINDING_UNVERIFIED, DESKTOP_SESSION_QUERY_FAILED, DESKTOP_SESSION_QUERY_UNSUPPORTED, DESKTOP_AUTH_BROKER_UNAVAILABLE,
    DESKTOP_CAPTURE_UNAVAILABLE;

    @JsonValue
    public String wire() {
        return name();
    }
}
