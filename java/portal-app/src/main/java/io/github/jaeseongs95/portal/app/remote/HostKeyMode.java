package io.github.jaeseongs95.portal.app.remote;

/** How the host key of a target is checked when no key is pinned (2.x {@code BRIDGE_HOST_KEY_MODE}). A pinned key always wins. */
public enum HostKeyMode {
    /** The first key of a host is recorded and trusted; a different key later is refused. */
    TOFU,
    /** Only a host that is already recorded is accepted. */
    STRICT,
    /** Every key is accepted. It exists for compatibility, and a start-up warning says so. */
    INSECURE
}
