package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code filePolicy.mode} on the wire (public-contract.mjs:45): where the authority for file paths comes from. */
public enum FileAccessModeWire {
    CONFIGURED_ROOT("configured-root"), TEST_SERVER_BYPASS("test-server-bypass"), SSH_ACCOUNT_PERMISSIONS("ssh-account-permissions");

    private final String wire;

    FileAccessModeWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
