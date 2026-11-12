package io.github.jaeseongs95.portal.domain.desktop;

/** Why a desktop is not ready (2.x desktop-state.mjs:4-5). The constant names are the wire codes. */
public enum DesktopBlocker {
    DESKTOP_AUTH_REQUIRED,
    DESKTOP_SESSION_BINDING_UNVERIFIED,
    DESKTOP_SESSION_QUERY_FAILED,
    DESKTOP_SESSION_QUERY_UNSUPPORTED,
    DESKTOP_AUTH_BROKER_UNAVAILABLE,
    DESKTOP_CAPTURE_UNAVAILABLE
}
