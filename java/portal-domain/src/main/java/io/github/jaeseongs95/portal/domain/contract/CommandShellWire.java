package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code capabilities.commandShell} on the wire (public-contract.mjs:53): the shell a command runs in on the target. */
public enum CommandShellWire {
    POSIX("posix"), WINDOWS_POWERSHELL_5_1("windows-powershell-5.1");

    private final String wire;

    CommandShellWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
