package io.github.jaeseongs95.portal.domain.target;

import com.fasterxml.jackson.annotation.JsonValue;

/** The shell commands run in on a target, by operating system (2.x target-platform.mjs:9). The wire values are {@code posix} and {@code windows-powershell-5.1}. */
public enum CommandShell {
    POSIX("posix"), WINDOWS_POWERSHELL_5_1("windows-powershell-5.1");

    private final String wire;

    CommandShell(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
